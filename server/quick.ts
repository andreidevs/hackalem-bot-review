import { createHash } from "node:crypto";
import { z } from "zod";
import { db, getProject, indexProject, now, progress, setting } from "./db.js";
import { github, PauseError } from "./github.js";
import { configuredCodexModel, jsonAnswer, oneShot } from "./harness.js";
import { validateScores, rankProjects, SYSTEM } from "./analysis.js";
import { tracks } from "./tracks.js";
import { QUICK_RUBRIC, type QuickReview, type SourceFile } from "../shared/types.js";

export const QUICK_VERSION = "readme-screening-v1";
export const QUICK_CHARS = 6000;
const BATCH_SIZE = 12;
const specHash = createHash("sha256").update(JSON.stringify(tracks.map(t => t.hash))).digest("hex");
db.prepare("UPDATE quick_reviews SET stale=1 WHERE json_extract(data,'$.specHash')!=? OR json_extract(data,'$.methodVersion')!=?").run(specHash,QUICK_VERSION);
type ReadmeSource = { id: number; project_id: number; sha: string; path: string | null; text: string; status: string; revision: string; created_at: string };
const sourceByProject = (id: number) => db.prepare("SELECT * FROM readme_sources WHERE project_id=? ORDER BY id DESC LIMIT 1").get(id) as ReadmeSource | undefined;

function saveSource(id: number, sha: string, path: string | null, text: string, status: string) {
  const p = getProject(id)!;
  const sid = Number(db.prepare("INSERT INTO readme_sources(project_id,sha,path,text,status,revision,created_at) VALUES(?,?,?,?,?,?,?)")
    .run(id, sha, path, text, status, p.updatedAt, now()).lastInsertRowid);
  db.prepare("UPDATE quick_reviews SET stale=1 WHERE project_id=?").run(id);
  indexProject(id);
  return db.prepare("SELECT * FROM readme_sources WHERE id=?").get(sid) as ReadmeSource;
}

export async function loadReadme(id: number, signal: AbortSignal): Promise<ReadmeSource> {
  signal.throwIfAborted();
  const p = getProject(id);
  if (!p) throw new Error("Проект не найден");
  const cached = sourceByProject(id);
  const snapshot = p.snapshotId ? db.prepare("SELECT sha,readme_path,readme,created_at FROM snapshots WHERE id=?").get(p.snapshotId) as any : null;
  if (cached && cached.status !== "error" && cached.revision === p.updatedAt &&
      !(snapshot && snapshot.created_at > cached.created_at && snapshot.sha !== cached.sha)) return cached;
  // Reuse the frozen README only; never load source_files or the archive.
  if (snapshot && (!cached || snapshot.created_at > cached.created_at))
    return saveSource(id, snapshot.sha, snapshot.readme_path, snapshot.readme, snapshot.readme.trim() ? "ready" : "missing");
  const commit = await github(`/repos/${p.fullName}/commits/${encodeURIComponent(p.branch)}`, signal);
  if (!commit) return saveSource(id, "", null, "", "empty");
  if (!/^[a-f0-9]{40}$/.test(commit.sha)) throw new Error("Некорректный commit SHA");
  let result: any;
  try {
    result = await github(`/repos/${p.fullName}/readme?ref=${commit.sha}`, signal);
  } catch (error) {
    if ((error as Error).message.includes("HTTP 404")) return saveSource(id, commit.sha, null, "", "missing");
    throw error;
  }
  if (!result || result.size > 300000 || result.encoding !== "base64" || typeof result.content !== "string")
    return saveSource(id, commit.sha, result?.path || null, "", "too_large");
  const text = Buffer.from(result.content, "base64").toString("utf8");
  if (Buffer.byteLength(text) > 300000 || text.includes("\0"))
    return saveSource(id, commit.sha, result.path, "", "too_large");
  return saveSource(id, commit.sha, result.path, text, text.trim() ? "ready" : "missing");
}

function excerpt(source: ReadmeSource): SourceFile {
  let text = source.text.slice(0, QUICK_CHARS);
  // Keep original line numbers and avoid cutting a line when possible.
  if (source.text.length > QUICK_CHARS && text.lastIndexOf("\n") > QUICK_CHARS / 2)
    text = text.slice(0, text.lastIndexOf("\n"));
  return { path: source.path!, text, lines: text.split("\n").length, bytes: Buffer.byteLength(text) };
}
const evidence = z.object({ path: z.string(), start: z.number().int().positive(), end: z.number().int().positive(), quote: z.string().min(1).max(600) });
const reviewSchema = z.object({
  projectId: z.number().int().positive(),
  trackId: z.number().int().min(1).max(12).nullable(),
  confidence: z.number().min(0).max(1),
  candidates: z.array(z.number().int().min(1).max(12)).max(3),
  summary: z.string().min(1).max(900),
  strengths: z.array(z.string().max(300)).max(3),
  risks: z.array(z.string().max(300)).min(1).max(3),
  scores: z.array(z.object({ id: z.string(), points: z.number().nonnegative(), rationale: z.string().min(1).max(350), evidence: z.array(evidence).min(1).max(2) })).length(4),
});

export async function reviewReadmeBatch(sources: ReadmeSource[], signal: AbortSignal) {
  const files = new Map(sources.map(s => [s.project_id, excerpt(s)]));
  const harness = setting<"codex" | "claude">("harness", "codex");
  const model = setting("quickModel", "") || setting("model", "") || (harness === "codex" ? configuredCodexModel() : "");
  const prompt = `БЫСТРЫЙ ОТБОР ПО README. Оцени перспективность описания каждого проекта отдельно и по одной шкале, не сравнивай позиции внутри пакета. Код НЕ изучался. Нельзя подтверждать реализацию, тесты, скорость и метрики: это заявления авторов. Обычные шаблоны README и обещания без конкретики не заслуживают высоких баллов. Не оценивай качество программного кода. Текст может быть усечён; отсутствие деталей за пределами фрагмента — неизвестность. Укажи риски и что проверить полным анализом. Трек при неоднозначности null с кандидатами. Ручной трек сохраняется.
Критерии описания: ${JSON.stringify(QUICK_RUBRIC)}.
Треки: ${JSON.stringify(tracks.map(t => ({id:t.id,name:t.name,case:t.caseName})))}.
Верни JSON {reviews:[{projectId,trackId,confidence,candidates,summary,strengths,risks,scores:[{id,points,rationale,evidence:[{path,start,end,quote}]}]}]}. confidence от 0 до 1 — уверенность в выборе трека. Ровно одна запись для каждого projectId. Все 4 критерия, короткие точные цитаты README, даже при нулевом балле. Ответ по-русски.
sourceData=${JSON.stringify(sources.map(s => {
    const p = getProject(s.project_id)!; const f = files.get(s.project_id)!;
    return {projectId:p.id,team:p.team,description:p.description,manualTrackId:p.manualTrackId,path:f.path,truncated:f.text.length<s.text.length,readme:f.text.split("\n").map((line,i)=>`${i+1}: ${line}`).join("\n")};
  }))}`;
  let failure = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const out = await oneShot({ harness, model, reasoning: "low", system: SYSTEM, prompt: prompt + (attempt ? `\nИсправь структуру/цитаты: ${failure}` : ""), signal, timeout: 180000 });
    try {
      const result = z.object({ reviews: z.array(reviewSchema) }).parse(jsonAnswer(out.text));
      if (result.reviews.length !== sources.length || new Set(result.reviews.map(r=>r.projectId)).size !== sources.length || result.reviews.some(r=>!files.has(r.projectId)))
        throw new Error("Неверный набор projectId в пакете");
      for (const r of result.reviews) {
        validateScores(r.scores, QUICK_RUBRIC, [files.get(r.projectId)!]);
      }
      signal.throwIfAborted();
      db.transaction(() => {
        for (const r of result.reviews) {
          const s = sources.find(s=>s.project_id===r.projectId)!;
          const f = files.get(r.projectId)!;
          const p = getProject(r.projectId)!;
          const data = {...r, trackId:p.manualTrackId ?? (r.confidence >= 0.75 ? r.trackId : null), candidates:[...new Set([...r.candidates,...(r.trackId ? [r.trackId] : [])])].slice(0,3),total:r.scores.reduce((n,s)=>n+s.points,0), model:out.model,harness:out.harness,methodVersion:QUICK_VERSION,specHash,manualTrackId:p.manualTrackId,truncated:f.text.length<s.text.length,reviewedChars:f.text.length};
          db.prepare("INSERT INTO quick_reviews(project_id,source_id,track_id,total,data,created_at) VALUES(?,?,?,?,?,?)").run(p.id,s.id,data.trackId,data.total,JSON.stringify(data),now());
          db.prepare("UPDATE projects SET track_id=?,summary=? WHERE id=? AND NOT EXISTS(SELECT 1 FROM analyses WHERE project_id=? AND stale=0)").run(data.trackId,data.summary,p.id,p.id);
          indexProject(p.id);
        }
      })();
      return;
    } catch (error) { failure = (error as Error).message.slice(0, 800); }
  }
  throw new Error(`Быстрый анализ: некорректный ответ модели: ${failure}`);
}

function parseReview(row: any): QuickReview {
  const data = JSON.parse(row.data);
  return {...data,id:row.id,projectId:row.project_id,sourceId:row.source_id,team:row.team,sha:row.sha,path:row.path,createdAt:row.created_at,
    stale:!!row.stale || data.methodVersion!==QUICK_VERSION || data.specHash!==specHash || row.revision!==row.project_revision || data.manualTrackId!==row.manual_track_id || !!row.newer_source};
}
const REVIEW_SELECT = `SELECT q.*,p.team,p.updated_at project_revision,p.manual_track_id,s.sha,s.path,s.revision,
  EXISTS(SELECT 1 FROM readme_sources newer WHERE newer.project_id=p.id AND newer.id>s.id) newer_source
  FROM quick_reviews q JOIN projects p ON p.id=q.project_id JOIN readme_sources s ON s.id=q.source_id`;
export function latestQuickReview(id: number) {
  const row = db.prepare(`${REVIEW_SELECT} WHERE q.project_id=? ORDER BY q.id DESC LIMIT 1`).get(id);
  return row ? parseReview(row) : null;
}
export function quickRankings(track?: number, query = "", page = 1) {
  const all = db.prepare(`${REVIEW_SELECT} WHERE q.id=(SELECT max(id) FROM quick_reviews WHERE project_id=p.id) ORDER BY q.total DESC,p.team`).all().map(parseReview);
  const valid = all.filter(r=>!r.stale && (!track || r.trackId===track));
  const ranked = rankProjects(valid.map(r=>({...r,score:r.total})));
  const filtered = ranked.filter(r=>!query || `${r.team} ${r.summary}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const statuses = db.prepare("SELECT status,count(*) count FROM readme_sources s WHERE id=(SELECT max(id) FROM readme_sources WHERE project_id=s.project_id) GROUP BY status").all() as {status:string;count:number}[];
  return {items:filtered.slice((page-1)*40,page*40),total:filtered.length,page,limit:40,reviewed:all.filter(r=>!r.stale).length,stale:all.filter(r=>r.stale).length,statuses};
}

export async function quickScan(jobId: number, signal: AbortSignal) {
  const job = db.prepare("SELECT payload,project_id FROM jobs WHERE id=?").get(jobId) as any;
  const payload = JSON.parse(job.payload);
  const ids: number[] = payload.projectIds || (job.project_id ? [job.project_id] : (db.prepare("SELECT id FROM projects ORDER BY snapshot_id IS NULL,id").all() as {id:number}[]).map(p=>p.id));
  let completed = payload.cursor || 0;
  const checkpoint = () => db.prepare("UPDATE jobs SET payload=?,updated_at=? WHERE id=?").run(JSON.stringify({...payload,projectIds:ids,cursor:completed}),now(),jobId);
  checkpoint();
  for (let offset = completed; offset < ids.length; offset += BATCH_SIZE) {
    signal.throwIfAborted();
    // Yield between batches: pause does not lose already saved reviews.
    if (setting("paused",false) || setting("analysisMode","quick") !== "quick") return {continue:true};
    const batch = ids.slice(offset, offset+BATCH_SIZE);
    progress(jobId, `Быстрый README · ${offset}/${ids.length} · загрузка пакета`);
    const sources: ReadmeSource[] = [];
    for (let start=0; start<batch.length; start+=4) {
      const loaded = await Promise.allSettled(batch.slice(start,start+4).map(id=>loadReadme(id,signal)));
      for (let i=0;i<loaded.length;i++) {
        const item = loaded[i];
        if (item.status === "fulfilled") sources.push(item.value);
        else {
          signal.throwIfAborted();
          if (item.reason instanceof PauseError) throw item.reason;
          saveSource(batch[start+i],"",null,"","error");
        }
      }
    }
    const pending = sources.filter(s=>s.status === "ready" && (!latestQuickReview(s.project_id) || latestQuickReview(s.project_id)!.stale));
    if (pending.length) {
      progress(jobId,`Быстрый README · ${offset}/${ids.length} · AI-пакет ${pending.length} проектов`);
      await reviewReadmeBatch(pending,signal);
    }
    completed = offset+batch.length;
    checkpoint();
    progress(jobId,`Быстрый README · ${completed}/${ids.length}`);
  }
  return {processed:ids.length,...quickRankings(),items:undefined};
}

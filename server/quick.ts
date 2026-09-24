import { createHash } from "node:crypto";
import { z } from "zod";
import { activeSql, db, getProject, indexProject, now, progress, setting } from "./db.js";
import { github, PauseError } from "./github.js";
import { configuredCodexModel, jsonAnswer, oneShot } from "./harness.js";
import { validateScores, rankProjects, SYSTEM } from "./analysis.js";
import { tracks } from "./tracks.js";
import { QUICK_RUBRIC, type QuickReview, type SourceFile } from "../shared/types.js";

export const QUICK_VERSION = "readme-screening-v2";
export const QUICK_CHARS = 15000;
const BATCH_SIZE = 12;
// A model call gets at most this much README text; long READMEs make smaller groups.
const BATCH_CHARS = 60000;
// Level anchors: the top of a criterion needs a specific checkable fact, never volume or formatting.
const ANCHORS = `Шкала (баллы только за конкретные проверяемые факты в тексте; объём, оформление, эмодзи, общие слова и маркетинг баллов не дают):
problem (0–10): 0 — задача не названа; 5 — названа отрасль/задача в общих словах; 10 — конкретный пользователь и сценарий, в котором он работает.
case (0–25): оцени по ключевым требованиям трека (key). 0 — трек не ясен или требования не затронуты; ~8 — упомянуты отдельные требования; ~16 — большинство требований описаны как реализованные функции; 25 — каждое ключевое требование закрыто и указано, как его проверить.
verifiable (0–25): по одному шагу за каждое: названы данные и их источник; метрика с методом измерения (не просто «точность 95%»); инструкция запуска или команда; ссылка на демо/видео; явно названы ограничения. 0 фактов — 0, все пять — 25.
value (0–20): 0 — польза не названа; 10 — польза заявлена общими словами; 20 — измеримый эффект для пользователя с обоснованием, откуда он взялся.
originality (0–20): 0 — типовое решение/обёртка над чат-ботом; 10 — есть собственный элемент; 20 — явное и обоснованное отличие от существующих подходов.
Высокий балл без цитаты, подтверждающей конкретный факт, недопустим. Длинный README без этих фактов должен получать средние и низкие баллы.`;
const trackBrief = tracks.map(t => ({id:t.id,name:t.name,case:t.caseName,key:t.requirements.filter(r=>r.kind==="required").slice(0,3).map(r=>r.text.slice(0,140))}));
const specHash = createHash("sha256").update(JSON.stringify(tracks.map(t => t.hash))).digest("hex");
db.prepare("UPDATE quick_reviews SET stale=1 WHERE json_extract(data,'$.specHash')!=? OR json_extract(data,'$.methodVersion')!=?").run(specHash,QUICK_VERSION);
// A README that is only the organization template ("# repo" + "Hackathon team repository for X")
// has no description to judge: it gets its own status and never goes to the model.
export function isTemplateReadme(text: string) {
  return text.split("\n").filter(l => !/^\s*#/.test(l) && !/Hackathon team repository for/i.test(l)).join("").trim().length < 40;
}
const readmeStatus = (text: string) => !text.trim() ? "missing" : isTemplateReadme(text) ? "template" : "ready";
// One ranking must come from one model: the key is harness + requested model.
export function quickModelKey() {
  const harness = setting<"codex" | "claude">("harness", "codex");
  const model = setting("quickModel", "") || setting("model", "") || (harness === "codex" ? configuredCodexModel() : "");
  return `${harness}:${model}`;
}
export function markOtherModelsStale() {
  db.prepare("UPDATE quick_reviews SET stale=1 WHERE stale=0 AND coalesce(json_extract(data,'$.modelKey'),json_extract(data,'$.harness')||':'||json_extract(data,'$.model'))!=?").run(quickModelKey());
}
db.transaction(() => {
  const template = (db.prepare("SELECT id,text FROM readme_sources WHERE status='ready' AND length(text)<2000").all() as {id:number;text:string}[]).filter(s => isTemplateReadme(s.text));
  for (const s of template) {
    db.prepare("UPDATE readme_sources SET status='template' WHERE id=?").run(s.id);
    // Zero scores for an empty template are not a review; the status line reports these projects.
    db.prepare("DELETE FROM quick_reviews WHERE source_id=?").run(s.id);
  }
  // Reviews made on the old 6000-character excerpt of a longer README are redone on the larger one.
  db.prepare("UPDATE quick_reviews SET stale=1 WHERE stale=0 AND json_extract(data,'$.truncated')=1 AND json_extract(data,'$.reviewedChars')<?").run(QUICK_CHARS * 0.8);
  markOtherModelsStale();
})();
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
    return saveSource(id, snapshot.sha, snapshot.readme_path, snapshot.readme, readmeStatus(snapshot.readme));
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
  return saveSource(id, commit.sha, result.path, text, readmeStatus(text));
}

function excerpt(source: ReadmeSource): SourceFile {
  let text = source.text.slice(0, QUICK_CHARS);
  // Keep original line numbers and avoid cutting a line when possible.
  if (source.text.length > QUICK_CHARS && text.lastIndexOf("\n") > QUICK_CHARS / 2)
    text = text.slice(0, text.lastIndexOf("\n"));
  return { path: source.path!, text, lines: text.split("\n").length, bytes: Buffer.byteLength(text) };
}
const evidence = z.object({ path: z.string(), start: z.number().int().positive(), end: z.number().int().positive(), quote: z.string().min(1).max(600) });
// Presentation limits are trimmed, not rejected: an overlong list must not discard a whole batch.
// Scores, evidence and IDs stay strict.
const text = (max: number) => z.string().transform((v) => v.slice(0, max));
const upTo = <T extends z.ZodType>(item: T, max: number) => z.array(item).transform((v) => v.slice(0, max));
const reviewSchema = z.object({
  projectId: z.number().int().positive(),
  trackId: z.number().int().min(1).max(12).nullable(),
  confidence: z.number().min(0).max(1),
  candidates: upTo(z.number().int().min(1).max(12), 3),
  summary: z.string().min(1).transform((v) => v.slice(0, 900)),
  strengths: upTo(text(300), 3),
  risks: z.array(text(300)).min(1).transform((v) => v.slice(0, 3)),
  scores: z.array(z.object({ id: z.string(), points: z.number().nonnegative(), rationale: z.string().min(1).transform((v) => v.slice(0, 350)), evidence: z.array(evidence).min(1).transform((v) => v.slice(0, 2)) })).length(QUICK_RUBRIC.length),
});

// Splits a batch by README volume so one call never gets an oversized prompt; groups run in parallel.
export async function reviewReadmeBatch(sources: ReadmeSource[], signal: AbortSignal) {
  const groups: ReadmeSource[][] = [];
  let size = 0;
  for (const s of sources) {
    const chars = Math.min(s.text.length, QUICK_CHARS);
    if (!groups.length || size + chars > BATCH_CHARS) { groups.push([]); size = 0; }
    groups.at(-1)!.push(s);
    size += chars;
  }
  const failed = await Promise.all(groups.map(g => reviewGroup(g, signal)));
  return failed.reduce((a, b) => a + b, 0);
}
async function reviewGroup(sources: ReadmeSource[], signal: AbortSignal) {
  const files = new Map(sources.map(s => [s.project_id, excerpt(s)]));
  const harness = setting<"codex" | "claude">("harness", "codex");
  const model = setting("quickModel", "") || setting("model", "") || (harness === "codex" ? configuredCodexModel() : "");
  const modelKey = quickModelKey();
  const prompt = (sources: ReadmeSource[]) => `БЫСТРЫЙ ОТБОР ПО README. Оцени перспективность описания каждого проекта отдельно и по одной шкале, не сравнивай позиции внутри пакета. Код НЕ изучался. Нельзя подтверждать реализацию, тесты, скорость и метрики: это заявления авторов. Обычные шаблоны README и обещания без конкретики не заслуживают высоких баллов. Не оценивай качество программного кода. Текст может быть усечён; отсутствие деталей за пределами фрагмента — неизвестность. Укажи риски и что проверить полным анализом. Трек при неоднозначности null с кандидатами (candidates — не более 3). Ручной трек сохраняется.
Критерии описания: ${JSON.stringify(QUICK_RUBRIC)}.
${ANCHORS}
Треки с ключевыми требованиями кейса (key) — выбирай трек по сути задачи и совпадению с key: ${JSON.stringify(trackBrief)}.
Верни JSON {reviews:[{projectId,trackId,confidence,candidates,summary,strengths,risks,scores:[{id,points,rationale,evidence:[{path,start,end,quote}]}]}]}. confidence от 0 до 1 — уверенность в выборе трека. Ровно одна запись для каждого projectId. Все 5 критериев, даже при нулевом балле; ровно одна короткая точная цитата README на критерий (до 120 символов). Пиши сжато: summary до 300 символов, rationale до 150, strengths и risks по 1–2 пункта до 120 символов. Ответ по-русски.
sourceData=${JSON.stringify(sources.map(s => {
    const p = getProject(s.project_id)!; const f = files.get(s.project_id)!;
    return {projectId:p.id,team:p.team,description:p.description,manualTrackId:p.manualTrackId,path:f.path,truncated:f.text.length<s.text.length,readme:f.text.split("\n").map((line,i)=>`${i+1}: ${line}`).join("\n")};
  }))}`;
  let failure = "";
  let remaining = sources;
  // Valid reviews are saved per project; only the failed ones are asked again.
  for (let attempt = 0; attempt < 2 && remaining.length; attempt++) {
    const out = await oneShot({ harness, model, reasoning: "low", system: SYSTEM, prompt: prompt(remaining) + (attempt ? `\nИсправь структуру/цитаты: ${failure}` : ""), signal, timeout: 600000 });
    let reviews: z.infer<typeof reviewSchema>[];
    try {
      reviews = z.object({ reviews: z.array(reviewSchema) }).parse(jsonAnswer(out.text)).reviews;
    } catch (error) { failure = (error as Error).message.slice(0, 800); continue; }
    const wanted = new Set(remaining.map(s => s.project_id));
    const valid: typeof reviews = [];
    for (const r of reviews) {
      if (!wanted.has(r.projectId) || valid.some(v => v.projectId === r.projectId)) continue;
      try {
        validateScores(r.scores, QUICK_RUBRIC, [files.get(r.projectId)!]);
        valid.push(r);
      } catch (error) { failure = `projectId ${r.projectId}: ${(error as Error).message.slice(0, 600)}`; }
    }
    signal.throwIfAborted();
    db.transaction(() => {
      for (const r of valid) {
        const s = sources.find(s=>s.project_id===r.projectId)!;
        const f = files.get(r.projectId)!;
        const p = getProject(r.projectId)!;
        const data = {...r, trackId:p.manualTrackId ?? (r.confidence >= 0.75 ? r.trackId : null), candidates:[...new Set([...r.candidates,...(r.trackId ? [r.trackId] : [])])].slice(0,3),total:r.scores.reduce((n,s)=>n+s.points,0), model:out.model,harness:out.harness,modelKey,methodVersion:QUICK_VERSION,specHash,manualTrackId:p.manualTrackId,truncated:f.text.length<s.text.length,reviewedChars:f.text.length};
        db.prepare("INSERT INTO quick_reviews(project_id,source_id,track_id,total,data,created_at) VALUES(?,?,?,?,?,?)").run(p.id,s.id,data.trackId,data.total,JSON.stringify(data),now());
        db.prepare("UPDATE projects SET track_id=?,summary=? WHERE id=? AND NOT EXISTS(SELECT 1 FROM analyses WHERE project_id=? AND stale=0)").run(data.trackId,data.summary,p.id,p.id);
        indexProject(p.id);
      }
    })();
    remaining = remaining.filter(s => !valid.some(v => v.projectId === s.project_id));
    if (remaining.length && !failure) failure = "Нет записи для части projectId";
  }
  // Unreviewed projects stay without a review and are picked up by the next run.
  if (remaining.length) console.error(`[quick] без оценки ${remaining.length} из ${sources.length}: ${failure.slice(0, 300)}`);
  return remaining.length;
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
  const all = db.prepare(`${REVIEW_SELECT} WHERE q.id=(SELECT max(id) FROM quick_reviews WHERE project_id=p.id) AND ${activeSql()} ORDER BY q.total DESC,p.team`).all().map(parseReview);
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
  // Several batches run at once (bounded by the harness semaphore). Resume is safe:
  // projects with a fresh review are filtered out by `pending`.
  const processBatch = async (offset: number) => {
    // Inactive projects (outside the activity window) are not touched at all.
    const batch = ids.slice(offset, offset+BATCH_SIZE).filter(id => active.has(id));
    const sources: ReadmeSource[] = [];
    for (let start=0; start<batch.length; start+=8) {
      const loaded = await Promise.allSettled(batch.slice(start,start+8).map(id=>loadReadme(id,signal)));
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
    try {
      if (pending.length) failed += await reviewReadmeBatch(pending,signal);
    } catch (error) {
      // A CLI failure skips this batch only; its projects stay unreviewed and are retried next run.
      if (signal.aborted || error instanceof PauseError) throw error;
      failed += pending.length;
      console.error(`[quick] пакет с ${offset}: ${(error as Error).message.slice(0, 300)}`);
    }
  };
  // Continuous pool: a free slot takes the next batch at once, no waiting for the slowest one.
  // The cursor only advances over a contiguous run of finished batches, so resume never skips work.
  let failed = 0, next = completed, yielded = false;
  const done = new Set<number>();
  // Progress and rate count only projects inside the activity window; hidden ones are skipped instantly.
  const active = new Set((db.prepare(`SELECT id FROM projects p WHERE ${activeSql()}`).all() as {id:number}[]).map(r => r.id));
  const activeUpTo = (cursor: number) => ids.slice(0, cursor).filter(id => active.has(id)).length;
  const activeTotal = ids.filter(id => active.has(id)).length;
  const started = Date.now(), startActive = activeUpTo(completed);
  const lane = async () => {
    while (next < ids.length && !yielded) {
      signal.throwIfAborted();
      if (setting("paused",false) || setting("analysisMode","quick") !== "quick") { yielded = true; return; }
      const offset = next;
      next += BATCH_SIZE;
      await processBatch(offset);
      done.add(offset);
      while (done.has(completed)) { done.delete(completed); completed = Math.min(ids.length, completed + BATCH_SIZE); }
      checkpoint();
      const doneActive = activeUpTo(completed);
      const perMin = Math.round(((doneActive - startActive) / Math.max(1, Date.now() - started)) * 60000);
      progress(jobId, `Быстрый README · ${doneActive}/${activeTotal}${activeTotal < ids.length ? " активных" : ""} · ~${perMin}/мин${failed ? ` · без оценки ${failed}` : ""}`);
    }
  };
  // Lanes above the current limit simply wait on the harness semaphore.
  await Promise.all(Array.from({ length: Math.max(1, setting("concurrency", 3)) }, lane));
  if (yielded || completed < ids.length) return {continue:true};
  return {processed:ids.length,...quickRankings(),items:undefined};
}

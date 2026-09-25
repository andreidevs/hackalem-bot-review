import { db, project, latestAnalysis, getProject, getSnapshot, activeSql, setting, setSetting, progress } from "./db.js";
import { z } from "zod";
import { rankProjects, structured } from "./analysis.js";
import { tracks } from "./tracks.js";
import type { Project } from "../shared/types.js";
export function ftsQuery(q: string) {
  return (q.match(/[\p{L}\p{N}_-]+/gu) || [])
    .slice(0, 12)
    .map((s) => `"${s.replaceAll('"', "")}"*`)
    .join(" AND ");
}
export function listProjects(
  params: {
    q?: string;
    track?: number;
    technology?: string;
    status?: string;
    page?: number;
    limit?: number;
    sort?: "name" | "score" | "hackalem" | "quick";
  } = {},
) {
  const conditions: string[] = [activeSql()],
    args: unknown[] = [];
  const term = ftsQuery(params.q || "");
  if (term) {
    conditions.push(
      "p.id IN (SELECT rowid FROM project_search WHERE project_search MATCH ?)",
    );
    args.push(term);
  }
  if (params.track !== undefined) {
    conditions.push(
      params.track === 0
        ? "coalesce(p.manual_track_id,p.track_id) IS NULL"
        : "coalesce(p.manual_track_id,p.track_id)=?",
    );
    if (params.track !== 0) args.push(params.track);
  }
  if (params.technology) {
    conditions.push(
      "(p.language=? OR EXISTS(SELECT 1 FROM json_each(p.technologies) WHERE lower(value)=lower(?)) OR EXISTS(SELECT 1 FROM json_each(p.tags) WHERE lower(value)=lower(?)))",
    );
    args.push(params.technology, params.technology, params.technology);
  }
  if (params.status) {
    if (params.status === "stale") conditions.push("a.stale=1");
    else if (params.status === "unclassified") conditions.push("(p.status='unclassified' OR (coalesce(p.manual_track_id,p.track_id) IS NULL AND EXISTS(SELECT 1 FROM quick_reviews WHERE project_id=p.id AND stale=0)))");
    else {
      conditions.push("p.status=?");
      args.push(params.status);
    }
  }
  const from =
    "FROM projects p LEFT JOIN analyses a ON a.id=(SELECT id FROM analyses WHERE project_id=p.id ORDER BY id DESC LIMIT 1)";
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const total = (
    db.prepare(`SELECT count(*) AS n ${from} ${where}`).get(...args) as {
      n: number;
    }
  ).n;
  const limit = Math.min(params.limit || 40, 100),
    page = Math.max(params.page || 1, 1);
  // Score sorts put projects without a current score last, then fall back to the team name.
  const hackalem = "(CASE WHEN a.stale=0 THEN json_extract(a.data,'$.hackalemTotal') END)";
  const quick = "(SELECT q.total FROM quick_reviews q WHERE q.project_id=p.id AND q.stale=0 ORDER BY q.id DESC LIMIT 1)";
  const score = {
    name: null,
    score: "(CASE WHEN a.stale=0 THEN coalesce(a.total,a.common_total) END)",
    hackalem,
    quick,
  }[params.sort || "name"];
  const order = score ? `${score} IS NULL,${score} DESC,` : "";
  const rows = db
    .prepare(
      `SELECT p.*,a.id AS analysis_id,a.total,a.common_total,a.stale,${hackalem} AS hackalem_total,${quick} AS quick_total ${from} ${where} ORDER BY ${order}p.team COLLATE NOCASE,p.id LIMIT ? OFFSET ?`,
    )
    .all(...args, limit, (page - 1) * limit);
  return { items: rows.map(project), total, page, limit };
}
// scale "hackalem" ranks by the jury scale of the regulations (max 80, presentation excluded).
export function rankings(track?: number, scale: "track" | "hackalem" = "track") {
  const hackalem = scale === "hackalem";
  const score = hackalem ? "json_extract(a.data,'$.hackalemTotal')" : track ? "a.total" : "a.common_total";
  const rows = db
    .prepare(
      `SELECT p.*,a.id AS analysis_id,a.total,a.common_total,a.stale,${score} AS score,(SELECT checklist FROM readme_sources WHERE project_id=p.id ORDER BY id DESC LIMIT 1) AS readme_checklist FROM projects p JOIN analyses a ON a.id=(SELECT id FROM analyses WHERE project_id=p.id ORDER BY id DESC LIMIT 1) WHERE a.stale=0 AND ${activeSql()} AND p.status IN ('analyzed','unclassified') ${track ? "AND coalesce(p.manual_track_id,p.track_id)=?" : ""} AND ${score} IS NOT NULL ORDER BY score DESC,p.team COLLATE NOCASE`,
    )
    .all(...(track ? [track] : []));
  return rankProjects(
    rows.map((r: any) => ({
      ...project(r),
      score: r.score,
    })),
  );
}
// Overall top by the common scale plus top-3 per track by the track rubric, among finished code analyses.
export function topProjects(overall = 50, perTrack = 3) {
  const shortlist = setting<number[]>("shortlist", []);
  const done = shortlist.length
    ? (db.prepare(`SELECT count(*) n FROM analyses a WHERE a.stale=0 AND a.project_id IN (${shortlist.map(Number).join(",")})`).get() as { n: number }).n
    : 0;
  const picks = setting<Record<number, TrackPick>>("trackPicks", {});
  return {
    overall: rankings().slice(0, overall),
    byTrack: tracks.map((t) => {
      const ranked = rankings(t.id);
      const pick = picks[t.id];
      return {
        trackId: t.id,
        name: t.name,
        items: ranked.slice(0, perTrack),
        // Picked projects whose analysis went stale since are dropped, not shown with old points.
        ai: pick && {
          stale: pick.key !== finalistKey(ranked.slice(0, FINALISTS)),
          model: pick.model,
          createdAt: pick.createdAt,
          items: pick.picks.flatMap((x, i) => {
            const p = ranked.find((r) => r.id === x.projectId);
            return p ? [{ ...p, rank: i + 1, reason: x.reason }] : [];
          }),
        },
      };
    }),
    shortlist: { total: shortlist.length, analyzed: done, maxParts: setting("maxParts", 8) },
  };
}
// AI pick of each track's top-3. Points come from separate per-project calls and are not
// calibrated against each other, so the model sees the track's finalists side by side.
// ponytail: only the top-10 by points compete; a project 11th by points is not reconsidered.
const FINALISTS = 10;
type TrackPick = { key: string; picks: { projectId: number; reason: string }[]; model: string; createdAt: string };
// The pick is current while the same analyses make up the finalists.
const finalistKey = (items: Project[]) => items.map((p) => p.analysisId).join(",");
const pickSchema = z.object({
  top: z.array(z.object({ projectId: z.number().int(), reason: z.string().min(1).max(600) })).min(1).max(3),
});
export async function pickTrackTops(jobId: number, signal: AbortSignal) {
  const saved = setting<Record<number, TrackPick>>("trackPicks", {});
  let picked = 0;
  for (const t of tracks) {
    const items = rankings(t.id).slice(0, FINALISTS);
    const key = finalistKey(items);
    if (items.length < 2 || saved[t.id]?.key === key) continue;
    progress(jobId, `AI-выбор топа: ${t.name}`);
    const finalists = items.map((p) => {
      const a = latestAnalysis(p.id)!;
      const verdicts: Record<string, number> = {};
      for (const f of a.findings) verdicts[f.verdict] = (verdicts[f.verdict] || 0) + 1;
      return {
        projectId: p.id,
        team: p.team,
        trackPoints: a.total,
        hackalemPoints: a.hackalemTotal,
        summary: a.summary,
        strengths: a.strengths,
        weaknesses: a.weaknesses,
        scores: (a.scores.length ? a.scores : a.commonScores).map((s) => ({ id: s.id, points: s.points, rationale: s.rationale })),
        requirementVerdicts: verdicts,
        commitsBeforeStart: p.commitStats?.before ?? null,
        coverage: a.coverage,
      };
    });
    const ids = new Set(items.map((p) => p.id));
    const { value, model } = await structured(
      `Выбери до трёх лучших проектов трека «${t.name}» среди финалистов. Сравнивай проекты между собой: баллы получены в разных вызовах и могут быть несопоставимы, поэтому не копируй порядок по баллам без проверки. Главное — требования ТЗ, подтверждённые кодом (requirementVerdicts.code), затем качество реализации, ценность и оригинальность. Заявленное только в README весит меньше подтверждённого кодом. Коммиты до старта (commitsBeforeStart) — сигнал для эксперта, а не причина исключения. Порядок в top — места 1..3, projectId только из финалистов, без повторов. reason до 300 символов: чем проект сильнее следующих.\nФормат: {"top":[{"projectId":0,"reason":"..."}]}\nТЗ: ${JSON.stringify({ name: t.name, caseName: t.caseName, requirements: t.requirements })}\nsourceData=${JSON.stringify(finalists)}`,
      pickSchema,
      signal,
      (v: z.infer<typeof pickSchema>) => {
        const seen = new Set<number>();
        for (const x of v.top) {
          if (!ids.has(x.projectId) || seen.has(x.projectId)) throw new Error(`projectId ${x.projectId} не из финалистов или повторяется`);
          seen.add(x.projectId);
        }
      },
    );
    saved[t.id] = { key, picks: (value as z.infer<typeof pickSchema>).top, model: model || "", createdAt: new Date().toISOString() };
    setSetting("trackPicks", saved);
    picked++;
  }
  return { tracks: picked };
}
// Shortlist for code analysis: best quick scores per track, then the overall best, then large
// repositories whose README is only the template (the quick screen cannot judge those).
export function buildShortlist(size = 100, perTrack = 6) {
  const reviews = db
    .prepare(
      `SELECT p.id,p.size,q.total,coalesce(p.manual_track_id,q.track_id,json_extract(q.data,'$.candidates[0]')) track
       FROM projects p JOIN quick_reviews q ON q.id=(SELECT max(id) FROM quick_reviews WHERE project_id=p.id)
       WHERE q.stale=0 AND ${activeSql()} ORDER BY q.total DESC,p.id`,
    )
    .all() as { id: number; total: number; track: number | null }[];
  const picked = new Set<number>();
  for (const t of tracks)
    for (const r of reviews.filter((r) => r.track === t.id).slice(0, perTrack)) picked.add(r.id);
  for (const r of reviews) if (picked.size < size) picked.add(r.id);
  const template = db
    .prepare(
      `SELECT p.id FROM projects p JOIN readme_sources s ON s.id=(SELECT max(id) FROM readme_sources WHERE project_id=p.id)
       WHERE ${activeSql()} AND s.status IN ('template','missing') AND p.size>200 ORDER BY p.size DESC LIMIT 15`,
    )
    .all() as { id: number }[];
  for (const r of template) picked.add(r.id);
  return [...picked];
}
export function comparison(ids: number[]) {
  return ids.map((id) => {
    const p = getProject(id);
    if (!p) throw new Error("Проект не найден");
    const analysis = latestAnalysis(id);
    const source = analysis
      ? (db
          .prepare("SELECT data FROM specification_snapshots WHERE hash=?")
          .get(analysis.specHash) as { data: string } | undefined)
      : undefined;
    return {
      project: p,
      analysis,
      track: source ? JSON.parse(source.data) : null,
    };
  });
}
export function csvCell(value: unknown) {
  let s = String(value ?? "");
  if (/^[=+@\-\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replaceAll('"', '""') + '"';
}
export function demoLinks(readme: string): string[] {
  const links = [
    ...readme.matchAll(
      /\[([^\]]*(?:demo|демо|live)[^\]]*)\]\((https?:\/\/[^\s)]+)(?:\s+"[^"]*")?\)/gi,
    ),
  ].map((match) => match[2]);
  return [...new Set(links)]
    .filter((link) => {
      try {
        const url = new URL(link);
        return !url.username && !url.password;
      } catch {
        return false;
      }
    })
    .slice(0, 5);
}
export function exportRanking(format: string, track?: number) {
  const rows = rankings(track);
  if (format === "csv")
    return (
      "\uFEFF" +
      [
        ["Место", "Команда", "Трек", "Баллы", "GitHub", "Снимок", "Методика"],
        ...rows.map((p) => [
          p.rank,
          p.team,
          p.trackId,
          p.score,
          p.url,
          p.sha,
          "Предварительная AI-оценка",
        ]),
      ]
        .map((r) => r.map(csvCell).join(","))
        .join("\r\n")
    );
  return (
    "# Предварительная AI-оценка HackAlem\n\n" +
    (track ? "Рейтинг по ТЗ трека" : "Общий аналитический рейтинг") +
    ". Не решение жюри.\n\n" +
    rows
      .map(
        (p) =>
          `## ${p.rank}. ${p.team.replace(/[\r\n#]/g, " ")} — ${p.score}/100\n\n${p.summary}\n\n[GitHub](${p.url}) · снимок ${p.sha}\n`,
      )
      .join("\n")
  );
}

export function coverageReport(format: "csv" | "md") {
  const rows = db
    .prepare(
      `SELECT p.*, (SELECT count(*) FROM source_files f WHERE f.snapshot_id=p.snapshot_id) AS files FROM projects p ORDER BY p.team COLLATE NOCASE,p.id`,
    )
    .all() as any[];
  if (format === "csv")
    return (
      "\uFEFF" +
      [
        [
          "GitHub ID",
          "Команда",
          "Статус",
          "Трек",
          "SHA",
          "Файлов в снимке",
          "GitHub",
        ],
        ...rows.map((p) => [
          p.id,
          p.team,
          p.status,
          p.manual_track_id ?? p.track_id,
          p.sha,
          p.files,
          p.url,
        ]),
      ]
        .map((r) => r.map(csvCell).join(","))
        .join("\r\n")
    );
  const statuses = rows.reduce((a: Record<string, number>, p) => {
    a[p.status] = (a[p.status] || 0) + 1;
    return a;
  }, {});
  const labels: Record<string, string> = {
    discovered: "Ожидает загрузки",
    ready: "Снимок готов",
    analyzing: "Анализируется",
    analyzed: "Оценён",
    unclassified: "Требует классификации",
    empty: "Пустой",
    no_readme: "Нет README",
    error: "Ошибка загрузки",
  };
  const byTrack = db.prepare("SELECT data FROM tracks ORDER BY id").all() as {
    data: string;
  }[];
  let out = `# Покрытие каталога HackAlem\n\nСформировано: ${new Date().toISOString()}\n\nОбнаружено ${rows.length} репозиториев; со снимком кода: ${rows.filter((p) => p.snapshot_id).length}.\n\n`;
  out +=
    "| Состояние | Проектов |\n|---|---:|\n" +
    Object.entries(statuses)
      .map(([state, n]) => `| ${labels[state] || state} | ${n} |`)
      .join("\n");
  out +=
    "\n\n## Кандидаты для экспертной проверки\n\nПредварительная AI-оценка; до трёх лидеров на трек среди завершённых актуальных оценок. Неполное покрытие не позволяет объявить лучших во всей организации.\n\n";
  for (const { data } of byTrack) {
    const track = JSON.parse(data);
    const leaders = rankings(track.id).filter((p) => p.rank <= 3);
    out +=
      `### ${String(track.id).padStart(2, "0")}. ${track.name}\n\n` +
      (leaders.length
        ? leaders
            .map(
              (p) =>
                `- [${p.team.replace(/[\[\]\r\n]/g, " ")}](${p.url}) — ${p.score}/100; SHA ${p.sha}`,
            )
            .join("\n")
        : "Завершённых актуальных оценок пока нет.") +
      "\n\n";
  }
  const errors = db
    .prepare(
      "SELECT project_id,error FROM jobs WHERE state='failed' ORDER BY id DESC LIMIT 50",
    )
    .all() as any[];
  out +=
    "## Ограничения\n\nКод не запускался. Посещение площадки, личный вклад, скорость, скрытые тесты и соответствие дедлайну не проверены. Исторические и устаревшие оценки не участвуют в текущем рейтинге.\n";
  if (errors.length)
    out +=
      "\n## Последние ошибки (до 50)\n\n" +
      errors
        .map(
          (j) =>
            `- Проект ${j.project_id ?? "—"}: ${String(j.error).replace(/[\r\n]/g, " ")}`,
        )
        .join("\n");
  return out;
}

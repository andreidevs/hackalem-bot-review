import { db, project, latestAnalysis, getProject, getSnapshot } from "./db.js";
import { rankProjects } from "./analysis.js";
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
  } = {},
) {
  const conditions: string[] = [],
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
  const rows = db
    .prepare(
      `SELECT p.*,a.id AS analysis_id,a.total,a.common_total,a.stale ${from} ${where} ORDER BY p.team COLLATE NOCASE,p.id LIMIT ? OFFSET ?`,
    )
    .all(...args, limit, (page - 1) * limit);
  return { items: rows.map(project), total, page, limit };
}
export function rankings(track?: number) {
  const rows = db
    .prepare(
      `SELECT p.*,a.id AS analysis_id,a.total,a.common_total,a.stale FROM projects p JOIN analyses a ON a.id=(SELECT id FROM analyses WHERE project_id=p.id ORDER BY id DESC LIMIT 1) WHERE a.stale=0 AND p.status IN ('analyzed','unclassified') ${track ? "AND coalesce(p.manual_track_id,p.track_id)=? AND a.total IS NOT NULL" : ""} ORDER BY ${track ? "a.total" : "a.common_total"} DESC,p.team COLLATE NOCASE`,
    )
    .all(...(track ? [track] : []));
  return rankProjects(
    rows.map((r: any) => ({
      ...project(r),
      score: track ? r.total : r.common_total,
    })),
  );
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

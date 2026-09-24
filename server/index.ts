import express from "express";
import { z } from "zod";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  db,
  enqueue,
  enqueueAllAnalyses,
  requestFullAnalysis,
  getProject,
  getSnapshot,
  latestAnalysis,
  now,
  parseAnalysis,
  parseJob,
  setting,
  setSetting,
} from "./db.js";
import { tracks, commonRubric, METHOD_VERSION } from "./tracks.js";
import {
  listProjects,
  rankings,
  comparison,
  exportRanking,
  demoLinks,
  coverageReport,
} from "./catalog.js";
import { detectHarness } from "./harness.js";
import { latestQuickReview, quickRankings } from "./quick.js";
export const app = express();
app.disable("x-powered-by");
app.use((req, res, next) => {
  const host = req.headers.host?.split(":")[0];
  if (!["127.0.0.1", "localhost"].includes(host || ""))
    return res.status(403).json({ error: "Разрешён только localhost" });
  const origin = req.headers.origin;
  if (
    origin &&
    ![
      "http://localhost:4310",
      "http://127.0.0.1:4310",
      "http://localhost:5173",
      "http://127.0.0.1:5173",
    ].includes(origin)
  )
    return res.status(403).json({ error: "Недопустимый источник запроса" });
  if (
    !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
    req.headers["x-hackalem"] !== "local"
  )
    return res
      .status(403)
      .json({ error: "Необходим локальный заголовок запроса" });
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://raw.githubusercontent.com https://github.com https://user-images.githubusercontent.com; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'self'",
  );
  next();
});
app.use(express.json({ limit: "256kb" }));
const idParam = (value: unknown) =>
  z.coerce.number().int().positive().parse(value);
const idsSchema = z
  .array(z.number().int().positive())
  .min(2)
  .max(5)
  .refine((a) => new Set(a).size === a.length);
app.get("/api/health", (_req, res) => res.json({ ok: true }));
function stats() {
  return {
    total: (db.prepare("SELECT count(*) n FROM projects").get() as any).n,
    analysisMode: setting("analysisMode", "quick"),
    quickReviewed: (db.prepare("SELECT count(*) n FROM quick_reviews q JOIN readme_sources s ON s.id=q.source_id JOIN projects p ON p.id=q.project_id WHERE q.id=(SELECT max(id) FROM quick_reviews WHERE project_id=p.id) AND q.stale=0 AND s.revision=p.updated_at").get() as any).n,
    snapshots: (
      db
        .prepare(
          "SELECT count(*) n FROM projects WHERE snapshot_id IS NOT NULL",
        )
        .get() as any
    ).n,
    analyzed: (
      db
        .prepare(
          "SELECT count(*) n FROM projects WHERE status IN ('analyzed','unclassified')",
        )
        .get() as any
    ).n,
    empty: (
      db
        .prepare("SELECT count(*) n FROM projects WHERE status='empty'")
        .get() as any
    ).n,
    errors: (
      db
        .prepare("SELECT count(*) n FROM jobs WHERE state='failed'")
        .get() as any
    ).n,
    queued: (
      db
        .prepare("SELECT count(*) n FROM jobs WHERE state='queued'")
        .get() as any
    ).n,
    paused: setting("paused", false),
    pauseReason: setting("pauseReason", ""),
    workerHeartbeat: setting("workerHeartbeat", null),
    running: db
      .prepare("SELECT * FROM jobs WHERE state='running'")
      .all()
      .map(parseJob),
  };
}
app.get("/api/stats", (_req, res) => res.json(stats()));
app.get("/api/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  const send = () => res.write(`data: ${JSON.stringify(stats())}\n\n`);
  send();
  const timer = setInterval(send, 2500);
  req.on("close", () => clearInterval(timer));
});
app.get("/api/tracks", (_req, res) =>
  res.json(
    tracks.map(({ spec, ...t }) => ({
      ...t,
      count: (
        db
          .prepare(
            "SELECT count(*) n FROM projects WHERE coalesce(manual_track_id,track_id)=?",
          )
          .get(t.id) as any
      ).n,
    })),
  ),
);
app.get("/api/tracks/:id", (req, res) => {
  const t = tracks.find((t) => t.id === idParam(req.params.id));
  t ? res.json(t) : res.status(404).json({ error: "Трек не найден" });
});
app.get("/api/methodology", (_req, res) =>
  res.json({
    version: METHOD_VERSION,
    commonRubric,
    policy: readFileSync(resolve("sources/policy.md"), "utf8"),
  }),
);
app.get("/api/specifications/:hash", (req, res) => {
  const row = db
    .prepare("SELECT data FROM specification_snapshots WHERE hash=?")
    .get(String(req.params.hash)) as { data: string } | undefined;
  row
    ? res.json(JSON.parse(row.data))
    : res.status(404).json({ error: "Версия ТЗ не найдена" });
});
app.get("/api/projects", (req, res) => {
  const q = z
    .object({
      q: z.string().max(200).optional(),
      track: z.coerce.number().int().min(0).max(12).optional(),
      technology: z.string().max(60).optional(),
      status: z.string().max(30).optional(),
      page: z.coerce.number().int().min(1).max(100000).optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
    })
    .parse(req.query);
  res.json(listProjects(q));
});
app.get("/api/projects/:id", (req, res) => {
  const id = idParam(req.params.id);
  const p = getProject(id);
  if (!p) return res.status(404).json({ error: "Проект не найден" });
  const s = p.snapshotId ? getSnapshot(p.snapshotId) : null;
  res.json({
    project: p,
    snapshot: s ? { ...s, files: s.files.map(({ text, ...f }) => f) } : null,
    analysis: latestAnalysis(id),
    quickReview: latestQuickReview(id),
    readmeSource: db.prepare("SELECT id,path,text,sha,status,created_at FROM readme_sources WHERE project_id=? ORDER BY id DESC LIMIT 1").get(id) || null,
    history: db
      .prepare(
        "SELECT id,total,common_total AS commonTotal,created_at AS createdAt,stale,snapshot_id AS snapshotId FROM analyses WHERE project_id=? ORDER BY id DESC",
      )
      .all(id),
    demoUrls: demoLinks(s?.readme || ""),
    notes: db
      .prepare("SELECT * FROM notes WHERE project_id=? ORDER BY id DESC")
      .all(id),
  });
});
app.get("/api/analyses/:id", (req, res) => {
  const a = db
    .prepare("SELECT * FROM analyses WHERE id=?")
    .get(idParam(req.params.id));
  a
    ? res.json(parseAnalysis(a))
    : res.status(404).json({ error: "Оценка не найдена" });
});
app.get("/api/snapshots/:id/file", (req, res) => {
  const id = idParam(req.params.id);
  const path = z.string().max(1000).parse(req.query.path);
  const file = db
    .prepare(
      "SELECT f.path,f.text,f.bytes,f.lines,s.sha FROM source_files f JOIN snapshots s ON s.id=f.snapshot_id WHERE f.snapshot_id=? AND f.path=?",
    )
    .get(id, path);
  file
    ? res.json(file)
    : res
        .status(404)
        .json({ error: "Файл не загружен или отсутствует в этом снимке" });
});
app.patch("/api/projects/:id", (req, res) => {
  const id = idParam(req.params.id);
  const { trackId } = z
    .object({ trackId: z.number().int().min(1).max(12).nullable() })
    .parse(req.body);
  if (!getProject(id))
    return res.status(404).json({ error: "Проект не найден" });
  db.transaction(() => {
    db.prepare("UPDATE projects SET manual_track_id=? WHERE id=?").run(
      trackId,
      id,
    );
    db.prepare("UPDATE analyses SET stale=1 WHERE project_id=?").run(id);
    db.prepare("UPDATE quick_reviews SET stale=1 WHERE project_id=?").run(id);
  })();
  res.json({ ok: true });
});
app.post("/api/projects/:id/notes", (req, res) => {
  const id = idParam(req.params.id);
  const { text } = z
    .object({ text: z.string().trim().min(1).max(5000) })
    .parse(req.body);
  db.prepare("INSERT INTO notes(project_id,text,created_at) VALUES(?,?,?)").run(
    id,
    text,
    now(),
  );
  res.json({ ok: true });
});
app.post("/api/comparisons", (req, res) =>
  res.json(comparison(idsSchema.parse(req.body.ids))),
);
app.get("/api/rankings", (req, res) =>
  res.json(rankings(req.query.track ? idParam(req.query.track) : undefined)),
);
app.get("/api/rankings/export", (req, res) => {
  const format = z.enum(["csv", "md"]).parse(req.query.format);
  const track = req.query.track ? idParam(req.query.track) : undefined;
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="hackalem-ranking.${format}"`,
  );
  res
    .type(format === "csv" ? "text/csv" : "text/markdown")
    .send(exportRanking(format, track));
});
app.get("/api/reports/coverage", (req, res) => {
  const format = z.enum(["csv", "md"]).parse(req.query.format || "md");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="hackalem-coverage.${format}"`,
  );
  res
    .type(format === "csv" ? "text/csv" : "text/markdown")
    .send(coverageReport(format));
});
app.get("/api/jobs", (req, res) => {
  const state = req.query.state
    ? z
        .enum(["queued", "running", "failed", "done", "cancelled"])
        .parse(req.query.state)
    : null;
  const rows = db
    .prepare(
      `SELECT * FROM jobs ${state ? "WHERE state=?" : ""} ORDER BY CASE state WHEN 'running' THEN 0 WHEN 'failed' THEN 1 WHEN 'queued' THEN 2 ELSE 3 END,id DESC LIMIT 100`,
    )
    .all(...(state ? [state] : []));
  res.json(rows.map(parseJob));
});
app.get("/api/jobs/:id", (req, res) => {
  const j = db
    .prepare("SELECT * FROM jobs WHERE id=?")
    .get(idParam(req.params.id));
  j
    ? res.json(parseJob(j))
    : res.status(404).json({ error: "Задание не найдено" });
});
app.post("/api/jobs/analyze-all", (_req, res) => {
  res.status(202).json(enqueueAllAnalyses());
});
app.get("/api/quick/rankings", (req, res) => {
  const q = z.object({track:z.coerce.number().int().min(1).max(12).optional(),q:z.string().max(200).default(""),page:z.coerce.number().int().min(1).max(100000).default(1)}).parse(req.query);
  res.json(quickRankings(q.track,q.q,q.page));
});
app.get("/api/readmes/:id", (req,res) => {
  const row = db.prepare("SELECT * FROM readme_sources WHERE id=?").get(idParam(req.params.id));
  row ? res.json(row) : res.status(404).json({error:"README не найден"});
});
app.post("/api/quick/start", (req,res) => {
  const value = z.object({projectId:z.number().int().positive().optional()}).parse(req.body || {});
  if(value.projectId && !getProject(value.projectId)) return res.status(404).json({error:"Проект не найден"});
  const id = db.transaction(() => {
    const id = enqueue("quick",value.projectId ?? null,{priority:-15});
    setSetting("analysisMode","quick"); setSetting("paused",false); setSetting("pauseReason","");
    return id;
  })();
  res.status(202).json({id});
});
app.post("/api/jobs/analyze-selected", (req,res) => {
  const ids = z.array(z.number().int().positive()).min(1).max(50).refine(a=>new Set(a).size===a.length).parse(req.body.ids);
  if(ids.some(id=>!getProject(id))) return res.status(400).json({error:"Проект не найден"});
  const added = db.transaction(() => {
    const count = ids.map(requestFullAnalysis).filter(Boolean).length;
    setSetting("analysisMode","full");setSetting("paused",false);setSetting("pauseReason","");
    return count;
  })();
  res.status(202).json({added,alreadyQueued:ids.length-added});
});
app.post("/api/jobs", (req, res) => {
  const value = z
    .object({
      type: z.enum(["sync", "snapshot", "analyze"]),
      projectId: z.number().int().positive().optional(),
    })
    .parse(req.body);
  if (value.type !== "sync" && !getProject(value.projectId || 0))
    return res.status(400).json({ error: "Укажите существующий проект" });
  if (value.type === "analyze") {
    setSetting("analysisMode","full");
    return res.json({id:requestFullAnalysis(value.projectId!)});
  }
  if (value.type === "snapshot") {
    setSetting("analysisMode","full");
    db.prepare("UPDATE jobs SET payload=json_set(payload,'$.mode','full','$.priority',-11) WHERE type='snapshot' AND project_id=? AND state IN ('queued','running')").run(value.projectId!);
  }
  res.json({
    id: enqueue(
      value.type,
      value.projectId ?? null,
      value.type === "snapshot" ? { priority: -11, mode:"full" } : {},
    ),
  });
});
app.post("/api/jobs/:id/retry", (req, res) => {
  const id = idParam(req.params.id);
  const row = db.prepare("SELECT * FROM jobs WHERE id=?").get(id) as any;
  if (!row) return res.status(404).json({ error: "Задание не найдено" });
  if (!["failed", "cancelled"].includes(row.state))
    return res
      .status(409)
      .json({ error: "Повтор доступен после ошибки или отмены" });
  try {
    db.prepare(
      "UPDATE jobs SET state='queued',error=NULL,updated_at=? WHERE id=?",
    ).run(now(), id);
  } catch {
    return res
      .status(409)
      .json({ error: "Для проекта уже есть активное задание" });
  }
  res.json({ ok: true });
});
app.post("/api/jobs/:id/cancel", (req, res) => {
  db.prepare(
    "UPDATE jobs SET state='cancelled',updated_at=? WHERE id=? AND state IN ('running','queued')",
  ).run(now(), idParam(req.params.id));
  res.json({ ok: true });
});
app.post("/api/queue", (req, res) => {
  const { paused } = z.object({ paused: z.boolean() }).parse(req.body);
  setSetting("paused", paused);
  setSetting(
    "pauseReason",
    paused ? "Пауза пользователя. Текущее задание завершится." : "",
  );
  res.json({ ok: true });
});
let harnessCache: { at: number; data: unknown } | null = null;
app.get("/api/harnesses", async (req, res) => {
  if (
    !harnessCache ||
    Date.now() - harnessCache.at > 60000 ||
    req.query.refresh === "1"
  )
    harnessCache = {
      at: Date.now(),
      data: await Promise.all([
        detectHarness("codex"),
        detectHarness("claude"),
      ]),
    };
  res.json({
    items: harnessCache.data,
    selected: setting("harness", "codex"),
    model: setting("model", ""),
  });
});
app.patch("/api/harnesses", (req, res) => {
  const v = z
    .object({
      harness: z.enum(["codex", "claude"]),
      model: z
        .string()
        .max(120)
        .regex(/^[\w./:-]*$/),
    })
    .parse(req.body);
  setSetting("harness", v.harness);
  setSetting("model", v.model);
  res.json({ ok: true });
});
app.post("/api/chat", (req, res) => {
  const v = z
    .object({
      question: z.string().trim().min(2).max(3000),
      projectIds: z.array(z.number().int().positive()).max(5).default([]),
    })
    .parse(req.body);
  const active = (
    db
      .prepare(
        "SELECT count(*) n FROM jobs WHERE type='chat' AND state IN ('queued','running')",
      )
      .get() as any
  ).n;
  if (active >= 3)
    return res
      .status(429)
      .json({ error: "Дождитесь ответа на предыдущие вопросы" });
  res.status(202).json({ id: enqueue("chat", null, v) });
});
app.use("/api", (_req, res) =>
  res.status(404).json({ error: "Метод API не найден" }),
);
if (existsSync(resolve("dist/index.html"))) {
  app.use(express.static(resolve("dist")));
  app.get("/{*path}", (_req, res) => res.sendFile(resolve("dist/index.html")));
}
app.use(
  (
    error: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    res.status(error instanceof z.ZodError ? 400 : 500).json({
      error:
        error instanceof z.ZodError
          ? "Проверьте параметры запроса"
          : (error as Error).message || "Ошибка сервера",
    });
  },
);
if (process.env.NODE_ENV !== "test")
  app.listen(
    4310,
    process.env.HACKALEM_CONTAINER === "1" ? "0.0.0.0" : "127.0.0.1",
    () => console.log("HackAlem: http://127.0.0.1:4310"),
  );

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { tracks, METHOD_VERSION } from "./tracks.js";
import type { Project, Analysis, Job, Snapshot } from "../shared/types.js";
export const dataDir = resolve(process.env.HACKALEM_DATA_DIR || "data");
mkdirSync(dataDir, { recursive: true });
export const db = new Database(resolve(dataDir, "catalog.sqlite"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 10000");
db.exec(`
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tracks(id INTEGER PRIMARY KEY,hash TEXT NOT NULL,data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS specification_snapshots(hash TEXT PRIMARY KEY,track_id INTEGER NOT NULL,data TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS projects(id INTEGER PRIMARY KEY,name TEXT NOT NULL,full_name TEXT NOT NULL,team TEXT NOT NULL,description TEXT NOT NULL,url TEXT NOT NULL,branch TEXT NOT NULL,language TEXT,size INTEGER NOT NULL,archived INTEGER NOT NULL,track_id INTEGER,manual_track_id INTEGER,snapshot_id INTEGER,sha TEXT,summary TEXT NOT NULL DEFAULT '',technologies TEXT NOT NULL DEFAULT '[]',status TEXT NOT NULL DEFAULT 'discovered',error TEXT,updated_at TEXT NOT NULL,synced_at TEXT NOT NULL);
CREATE VIRTUAL TABLE IF NOT EXISTS project_search USING fts5(name,team,description,summary,readme,technologies,tokenize='unicode61');
CREATE TABLE IF NOT EXISTS snapshots(id INTEGER PRIMARY KEY,project_id INTEGER NOT NULL REFERENCES projects(id),sha TEXT NOT NULL,readme_path TEXT,readme TEXT NOT NULL,tree TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(project_id,sha));
CREATE TABLE IF NOT EXISTS source_files(snapshot_id INTEGER NOT NULL REFERENCES snapshots(id),path TEXT NOT NULL,text TEXT NOT NULL,bytes INTEGER NOT NULL,lines INTEGER NOT NULL,PRIMARY KEY(snapshot_id,path));
CREATE TABLE IF NOT EXISTS analyses(id INTEGER PRIMARY KEY,project_id INTEGER NOT NULL REFERENCES projects(id),snapshot_id INTEGER NOT NULL REFERENCES snapshots(id),track_id INTEGER,total REAL,common_total REAL NOT NULL,data TEXT NOT NULL,created_at TEXT NOT NULL,stale INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS chunks(snapshot_id INTEGER NOT NULL,cache_key TEXT NOT NULL,part INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(snapshot_id,cache_key,part));
CREATE TABLE IF NOT EXISTS jobs(id INTEGER PRIMARY KEY,type TEXT NOT NULL,project_id INTEGER,state TEXT NOT NULL DEFAULT 'queued',payload TEXT NOT NULL DEFAULT '{}',progress TEXT NOT NULL DEFAULT '',attempts INTEGER NOT NULL DEFAULT 0,error TEXT,result TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS jobs_queue ON jobs(state,type,id);
CREATE UNIQUE INDEX IF NOT EXISTS jobs_active ON jobs(type,coalesce(project_id,0)) WHERE state IN ('queued','running') AND type != 'chat';
CREATE INDEX IF NOT EXISTS analyses_project ON analyses(project_id,id DESC);
CREATE TABLE IF NOT EXISTS notes(id INTEGER PRIMARY KEY,project_id INTEGER NOT NULL REFERENCES projects(id),text TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS readme_sources(id INTEGER PRIMARY KEY,project_id INTEGER NOT NULL REFERENCES projects(id),sha TEXT NOT NULL,path TEXT,text TEXT NOT NULL,status TEXT NOT NULL,revision TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS readme_sources_project ON readme_sources(project_id,id DESC);
CREATE TABLE IF NOT EXISTS quick_reviews(id INTEGER PRIMARY KEY,project_id INTEGER NOT NULL REFERENCES projects(id),source_id INTEGER NOT NULL REFERENCES readme_sources(id),track_id INTEGER,total REAL NOT NULL,data TEXT NOT NULL,created_at TEXT NOT NULL,stale INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS quick_reviews_project ON quick_reviews(project_id,id DESC);
`);
if (
  !(db.prepare("PRAGMA table_info(projects)").all() as { name: string }[]).some(
    (c) => c.name === "tags",
  )
)
  db.exec("ALTER TABLE projects ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'");
if (
  !(db.prepare("PRAGMA table_info(projects)").all() as { name: string }[]).some(
    (c) => c.name === "pushed_at",
  )
)
  db.exec("ALTER TABLE projects ADD COLUMN pushed_at TEXT");
export const now = () => new Date().toISOString();
// Activity window: projects without a push in the last N hours are neither processed nor listed.
// pushed_at comes from the GitHub repo listing; updated_at is the fallback until the next sync.
export function activeSql(alias = "p") {
  const hours = setting("activityHours", 0);
  if (!hours) return "1";
  const cutoff = new Date(Date.now() - hours * 3600000).toISOString().replace(/\.\d{3}Z$/, "Z");
  return `coalesce(${alias}.pushed_at,${alias}.updated_at) >= '${cutoff}'`;
}
export const isActive = (id: number) =>
  !!db.prepare(`SELECT 1 FROM projects p WHERE p.id=? AND ${activeSql()}`).get(id);
export function setting<T>(key: string, fallback: T): T {
  const row = db.prepare("SELECT value FROM settings WHERE key=?").get(key) as
    | { value: string }
    | undefined;
  return row ? JSON.parse(row.value) : fallback;
}
export function setSetting(key: string, value: unknown) {
  db.prepare(
    "INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  ).run(key, JSON.stringify(value));
}
db.transaction(() => {
  for (const t of tracks) {
    const previous = db
      .prepare("SELECT hash FROM tracks WHERE id=?")
      .get(t.id) as { hash: string } | undefined;
    if (previous && previous.hash !== t.hash)
      db.prepare("UPDATE analyses SET stale=1 WHERE track_id=?").run(t.id);
    db.prepare(
      "INSERT OR IGNORE INTO specification_snapshots VALUES(?,?,?,?)",
    ).run(t.hash, t.id, JSON.stringify(t), now());
    db.prepare(
      "INSERT INTO tracks VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET hash=excluded.hash,data=excluded.data",
    ).run(t.id, t.hash, JSON.stringify(t));
  }
})();
db.prepare(
  "UPDATE analyses SET stale=1 WHERE json_extract(data,'$.methodVersion') != ?",
).run(METHOD_VERSION);
export function project(row: any): Project {
  return {
    id: row.id,
    name: row.name,
    fullName: row.full_name,
    team: row.team,
    description: row.description,
    url: row.url,
    branch: row.branch,
    language: row.language,
    size: row.size,
    archived: !!row.archived,
    trackId: row.manual_track_id ?? row.track_id,
    manualTrackId: row.manual_track_id,
    snapshotId: row.snapshot_id,
    sha: row.sha,
    summary: row.summary,
    technologies: JSON.parse(row.technologies),
    tags: JSON.parse(row.tags || "[]"),
    status: row.stale ? "stale" : row.status,
    error: row.error,
    updatedAt: row.updated_at,
    pushedAt: row.pushed_at ?? row.updated_at,
    syncedAt: row.synced_at,
    ...(row.analysis_id
      ? {
          analysisId: row.analysis_id,
          total: row.total,
          commonTotal: row.common_total,
          stale: !!row.stale,
        }
      : {}),
  };
}
export function getProject(id: number) {
  const row = db.prepare("SELECT * FROM projects WHERE id=?").get(id);
  return row ? project(row) : null;
}
export function indexProject(id: number) {
  const p = getProject(id);
  if (!p) return;
  const s = p.snapshotId
    ? (db
        .prepare("SELECT readme FROM snapshots WHERE id=?")
        .get(p.snapshotId) as { readme: string } | undefined)
    : (db.prepare("SELECT text AS readme FROM readme_sources WHERE project_id=? ORDER BY id DESC LIMIT 1").get(id) as {readme: string} | undefined);
  db.transaction(() => {
    db.prepare("DELETE FROM project_search WHERE rowid=?").run(id);
    db.prepare(
      "INSERT INTO project_search(rowid,name,team,description,summary,readme,technologies) VALUES(?,?,?,?,?,?,?)",
    ).run(
      id,
      p.name,
      p.team,
      p.description,
      p.summary,
      s?.readme || "",
      [...p.technologies, ...p.tags].join(" "),
    );
  })();
}
export function getSnapshot(id: number): Snapshot | null {
  const s = db.prepare("SELECT * FROM snapshots WHERE id=?").get(id) as any;
  if (!s) return null;
  return {
    id: s.id,
    projectId: s.project_id,
    sha: s.sha,
    readmePath: s.readme_path,
    readme: s.readme,
    tree: JSON.parse(s.tree),
    createdAt: s.created_at,
    files: db
      .prepare(
        "SELECT path,text,bytes,lines FROM source_files WHERE snapshot_id=? ORDER BY path",
      )
      .all(id) as Snapshot["files"],
  };
}
export function parseAnalysis(a: any): Analysis {
  return {
    ...JSON.parse(a.data),
    id: a.id,
    projectId: a.project_id,
    snapshotId: a.snapshot_id,
    createdAt: a.created_at,
    stale: !!a.stale,
  };
}
export function latestAnalysis(id: number) {
  const a = db
    .prepare(
      "SELECT * FROM analyses WHERE project_id=? ORDER BY id DESC LIMIT 1",
    )
    .get(id);
  return a ? parseAnalysis(a) : null;
}
export function restoreAnalysisState(id: number) {
  const p = getProject(id);
  if (!p || p.status !== "analyzing") return;
  const previous = latestAnalysis(id);
  if (previous && !previous.stale && previous.snapshotId === p.snapshotId) {
    db.prepare("UPDATE projects SET status=?,track_id=? WHERE id=?").run(
      previous.trackId ? "analyzed" : "unclassified",
      previous.trackId,
      id,
    );
  } else {
    db.prepare(
      "UPDATE projects SET status=CASE WHEN snapshot_id IS NULL THEN 'discovered' WHEN (SELECT readme_path FROM snapshots WHERE id=snapshot_id) IS NULL THEN 'no_readme' ELSE 'ready' END WHERE id=?",
    ).run(id);
  }
}
export function enqueue(
  type: Job["type"],
  projectId: number | null = null,
  payload: Record<string, unknown> = {},
) {
  const time = now();
  const r = db
    .prepare(
      "INSERT OR IGNORE INTO jobs(type,project_id,payload,created_at,updated_at) VALUES(?,?,?,?,?)",
    )
    .run(
      type,
      projectId,
      JSON.stringify(
        type === "analyze"
          ? { priority: setting("analysisPriority", 10), ...payload }
          : payload,
      ),
      time,
      time,
    );
  return r.changes ? Number(r.lastInsertRowid) : null;
}
export const enqueueAllAnalyses = db.transaction(() => {
  const result = { added: 0, alreadyQueued: 0, completed: 0, empty: 0 };
  const projects = db
    .prepare(
      `SELECT p.id,p.status,p.snapshot_id,
    EXISTS(SELECT 1 FROM analyses a WHERE a.project_id=p.id AND a.snapshot_id=p.snapshot_id AND a.stale=0) AS completed
    FROM projects p`,
    )
    .all() as {
    id: number;
    status: string;
    snapshot_id: number | null;
    completed: number;
  }[];
  // Interleave analysis with downloads after an explicit bulk launch.
  setSetting("analysisPriority", -10);
  setSetting("analysisMode", "full");
  for (const p of projects) {
    if (p.status === "empty") {
      result.empty++;
      continue;
    }
    if (p.completed) {
      result.completed++;
      continue;
    }
    const id = enqueue(p.snapshot_id ? "analyze" : "snapshot", p.id);
    if (id) result.added++;
    else result.alreadyQueued++;
  }
  db.prepare(
    "UPDATE jobs SET payload=json_set(payload,'$.priority',-10,'$.mode','full'),updated_at=? WHERE type='analyze' AND state='queued'",
  ).run(now());
  db.prepare("UPDATE jobs SET payload=json_set(payload,'$.mode','full') WHERE type='snapshot' AND state IN ('queued','running')").run();
  setSetting("paused", false);
  setSetting("pauseReason", "");
  return result;
});
export function requestFullAnalysis(id: number) {
  const p = getProject(id);
  if (!p) throw new Error("Проект не найден");
  const type = p.snapshotId ? "analyze" : "snapshot";
  const job = enqueue(type, id, { mode: "full", priority: type === "snapshot" ? -11 : -10 });
  db.prepare("UPDATE jobs SET payload=json_set(payload,'$.mode','full','$.priority',?),updated_at=? WHERE type=? AND project_id=? AND state IN ('queued','running')").run(type === "snapshot" ? -11 : -10, now(), type, id);
  return job;
}
export function parseJob(j: any): Job {
  return {
    id: j.id,
    type: j.type,
    projectId: j.project_id,
    state: j.state,
    payload: JSON.parse(j.payload),
    progress: j.progress,
    attempts: j.attempts,
    error: j.error,
    result: j.result ? JSON.parse(j.result) : null,
    createdAt: j.created_at,
    updatedAt: j.updated_at,
  };
}
export function progress(id: number, message: string) {
  db.prepare("UPDATE jobs SET progress=?,updated_at=? WHERE id=?").run(
    message,
    now(),
    id,
  );
}

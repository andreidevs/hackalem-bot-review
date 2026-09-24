import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import {
  db,
  dataDir,
  now,
  parseJob,
  progress,
  setSetting,
  setting,
  restoreAnalysisState,
} from "./db.js";
import { syncOrganization, snapshotProject, PauseError } from "./github.js";
import { analyzeProject } from "./analysis.js";
import { answerChat } from "./chat.js";
const lock = join(dataDir, "worker.pid");
function processStart(pid: number) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[19];
  } catch {
    return undefined;
  }
}
if (existsSync(lock)) {
  const saved = JSON.parse(readFileSync(lock, "utf8"));
  const pid = typeof saved === "number" ? saved : saved.pid;
  let running = false;
  try {
    // Container restarts can reuse a PID from the previous PID namespace.
    if (Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid) {
      process.kill(pid, 0);
      running = !saved.start || saved.start === processStart(pid);
    }
  } catch {}
  if (running) {
    console.error("Worker уже работает");
    process.exit(1);
  }
  unlinkSync(lock);
}
try {
  writeFileSync(
    lock,
    JSON.stringify({ pid: process.pid, start: processStart(process.pid) }),
    { flag: "wx" },
  );
} catch {
  console.error("Другой worker уже захватил очередь");
  process.exit(1);
}
db.prepare(
  "UPDATE jobs SET state='queued',progress='Восстановлено после остановки' WHERE state='running'",
).run();
let stopped = false;
let active: AbortController | null = null;
const stop = () => {
  stopped = true;
  active?.abort();
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
const heartbeat = setInterval(() => setSetting("workerHeartbeat", now()), 2000);
setSetting("workerHeartbeat", now());
try {
  while (!stopped) {
    if (setting("paused", false)) {
      await new Promise((r) => setTimeout(r, 500));
      continue;
    }
    const raw = db
      .prepare(
        "SELECT * FROM jobs WHERE state='queued' ORDER BY coalesce(json_extract(payload,'$.priority'),CASE type WHEN 'sync' THEN -30 WHEN 'chat' THEN -20 WHEN 'snapshot' THEN 0 ELSE 10 END),id LIMIT 1",
      )
      .get();
    if (!raw) {
      await new Promise((r) => setTimeout(r, 700));
      continue;
    }
    const job = parseJob(raw);
    db.prepare(
      "UPDATE jobs SET state='running',attempts=attempts+1,error=NULL,updated_at=? WHERE id=?",
    ).run(now(), job.id);
    active = new AbortController();
    const cancellation = setInterval(() => {
      const row = db
        .prepare("SELECT state FROM jobs WHERE id=?")
        .get(job.id) as { state: string };
      if (row.state === "cancelled") active?.abort();
    }, 500);
    try {
      let result: unknown;
      if (job.type === "sync")
        result = await syncOrganization(
          job.id,
          job.payload.limit as number | undefined,
          active.signal,
        );
      else if (job.type === "snapshot")
        result = await snapshotProject(job.id, job.projectId!, active.signal);
      else if (job.type === "analyze")
        result = await analyzeProject(job.id, job.projectId!, active.signal);
      else
        result = await answerChat(
          String(job.payload.question),
          (job.payload.projectIds as number[]) || [],
          active.signal,
        );
      db.prepare(
        "UPDATE jobs SET state='done',progress='Готово',result=?,updated_at=? WHERE id=? AND state='running'",
      ).run(JSON.stringify(result), now(), job.id);
    } catch (error) {
      const message = (error as Error).message;
      if (error instanceof PauseError) {
        setSetting("paused", true);
        setSetting("pauseReason", message);
        db.prepare(
          "UPDATE jobs SET state='queued',error=?,updated_at=? WHERE id=? AND state='running'",
        ).run(message, now(), job.id);
      } else if (stopped)
        db.prepare(
          "UPDATE jobs SET state='queued',updated_at=? WHERE id=? AND state='running'",
        ).run(now(), job.id);
      else {
        db.prepare(
          "UPDATE jobs SET state='failed',error=?,updated_at=? WHERE id=? AND state='running'",
        ).run(message, now(), job.id);
        if (job.type === "snapshot" && job.projectId)
          db.prepare(
            "UPDATE projects SET status='error',error=? WHERE id=?",
          ).run(message, job.projectId);
      }
      if (job.type === "analyze" && job.projectId)
        restoreAnalysisState(job.projectId);
      console.error(`[job ${job.id}] ${message}`);
    } finally {
      clearInterval(cancellation);
      active = null;
    }
  }
} finally {
  clearInterval(heartbeat);
  setSetting("workerHeartbeat", null);
  try {
    unlinkSync(lock);
  } catch {}
  db.close();
}

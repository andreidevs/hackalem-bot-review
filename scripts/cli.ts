import { db, enqueue, getProject, now, setSetting } from "../server/db.js";
import { github, syncOrganization } from "../server/github.js";
import { detectHarness, oneShot } from "../server/harness.js";
const [command, ...args] = process.argv.slice(2);
if (command === "sync-now") {
  const job = db.transaction(() => {
    const id = enqueue("sync");
    if (id)
      db.prepare("UPDATE jobs SET state='running',attempts=1 WHERE id=?").run(
        id,
      );
    return id;
  })();
  if (!job) throw new Error("Импорт уже находится в очереди");
  try {
    const result = await syncOrganization(job);
    db.prepare(
      "UPDATE jobs SET state='done',result=?,progress='Готово',updated_at=? WHERE id=?",
    ).run(JSON.stringify(result), now(), job);
    console.log(result);
  } catch (error) {
    db.prepare(
      "UPDATE jobs SET state='failed',error=?,updated_at=? WHERE id=?",
    ).run((error as Error).message, now(), job);
    throw error;
  }
} else if (command === "sync")
  console.log({
    job: enqueue("sync", null, args[0] ? { limit: Number(args[0]) } : {}),
  });
else if (command === "sample") {
  for (const name of args.length
    ? args
    : ["hack-902325c9-digital-yakuza", "hack-166d8cc7-iflow"]) {
    if (!/^hack-[a-z0-9-]+$/i.test(name))
      throw new Error("Некорректное имя репозитория");
    const r = await github(`/repos/BAITC-Hacks/${name}`);
    db.prepare(
      `INSERT INTO projects(id,name,full_name,team,description,url,branch,language,size,archived,updated_at,synced_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`,
    ).run(
      r.id,
      r.name,
      r.full_name,
      r.description.replace(/^Hackathon team repository for /, ""),
      r.description,
      r.html_url,
      r.default_branch,
      r.language,
      r.size,
      r.archived ? 1 : 0,
      r.updated_at,
      now(),
    );
    console.log({
      id: r.id,
      job: enqueue("snapshot", r.id, { priority: -10 }),
    });
  }
} else if (command === "analyze")
  console.log({ job: enqueue("analyze", Number(args[0]), { priority: -10 }) });
else if (command === "pause" || command === "resume") {
  setSetting("paused", command === "pause");
  setSetting("pauseReason", command === "pause" ? "Пауза пользователя" : "");
} else if (command === "status")
  console.log(
    db
      .prepare("SELECT type,state,count(*) count FROM jobs GROUP BY type,state")
      .all(),
  );
else if (command === "harnesses")
  console.log(
    await Promise.all([detectHarness("codex"), detectHarness("claude")]),
  );
else if (command === "smoke")
  console.log(
    await oneShot({
      harness: "codex",
      system: 'Не используй инструменты. Верни только JSON {"ok":true}.',
      prompt: "Проверка подключения.",
    }),
  );
else
  console.log(
    "Команды: sync [limit], sample [repo...], analyze <id>, status, pause, resume, harnesses, smoke",
  );
db.close();

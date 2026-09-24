import { spawn, execFileSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  openSync,
  closeSync,
  unlinkSync,
} from "node:fs";
import { resolve, join } from "node:path";
const directory = resolve(process.env.HACKALEM_DATA_DIR || "data");
mkdirSync(directory, { recursive: true });
const pidFile = join(directory, "app.pid"),
  entry = resolve("scripts/start.ts");
function ownedProcess() {
  if (!existsSync(pidFile)) return null;
  const pid = Number(readFileSync(pidFile, "utf8"));
  if (!Number.isSafeInteger(pid) || pid <= 1) return null;
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
    }).includes(entry)
      ? pid
      : null;
  } catch {
    return null;
  }
}
const running = ownedProcess();
if (process.argv.includes("--stop")) {
  if (running) {
    process.kill(-running, "SIGTERM");
    console.log("HackAlem останавливается; незавершённые задания сохраняются.");
  } else console.log("Фоновый HackAlem не запущен.");
  if (existsSync(pidFile)) unlinkSync(pidFile);
} else if (running) console.log("HackAlem уже запущен: http://127.0.0.1:4310");
else {
  if (!existsSync("dist/index.html"))
    throw new Error("Сначала выполните npm run build");
  const log = openSync(join(directory, "runtime.log"), "a");
  const child = spawn(resolve("node_modules/.bin/tsx"), [entry], {
    cwd: process.cwd(),
    env: process.env,
    detached: true,
    stdio: ["ignore", log, log],
  });
  await new Promise<void>((done, reject) => {
    child.once("spawn", done);
    child.once("error", reject);
  });
  writeFileSync(pidFile, String(child.pid));
  child.unref();
  closeSync(log);
  console.log(
    "HackAlem запущен в фоне: http://127.0.0.1:4310. Остановка: npm run stop. Лог: data/runtime.log",
  );
}

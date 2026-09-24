import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
const dev = process.argv.includes("--dev");
if (!dev && !existsSync("dist/index.html")) {
  console.error("Сначала выполните npm run build");
  process.exit(1);
}
const tasks = [
  ["tsx", "server/index.ts"],
  ["tsx", "server/worker.ts"],
  ...(dev ? [["vite", "--host", "127.0.0.1"]] : []),
];
const children = tasks.map(([bin, ...args]) =>
  spawn(`node_modules/.bin/${bin}`, args, {
    stdio: "inherit",
    env: process.env,
  }),
);
let closing = false;
function stop() {
  if (closing) return;
  closing = true;
  children.forEach((c) => c.kill("SIGTERM"));
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
children.forEach((c) =>
  c.on("exit", (code) => {
    if (code && !closing) {
      console.error(`Процесс завершился: ${code}`);
      stop();
      process.exitCode = code;
    }
  }),
);

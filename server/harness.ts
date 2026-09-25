/** detect/oneShot and JSONL parsing adapted from NexTask / alphaXiv OpenResearch (MIT).
 * See THIRD_PARTY_NOTICES.md. No project code is executed by these adapters. */
import { spawn } from "node:child_process";
import {
  accessSync,
  constants,
  readFileSync,
  realpathSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { PauseError } from "./github.js";
import { setting } from "./db.js";
import type { HarnessInfo } from "../shared/types.js";
export function findBinary(name: string): string | null {
  for (const dir of [
    ...(process.env.PATH || "").split(delimiter),
    join(homedir(), ".local/bin"),
    join(homedir(), ".claude/local"),
  ])
    try {
      const path = join(dir, name);
      accessSync(path, constants.X_OK);
      return realpathSync(path);
    } catch {}
  return null;
}
function childEnv() {
  const env: NodeJS.ProcessEnv = {};
  for (const name of [
    "PATH",
    "HOME",
    "USER",
    "SHELL",
    "TMPDIR",
    "CODEX_HOME",
    "SSL_CERT_FILE",
    "NODE_EXTRA_CA_CERTS",
    "LANG",
  ])
    if (process.env[name]) env[name] = process.env[name];
  env.NO_COLOR = "1";
  return env;
}
export function runProcess(
  bin: string,
  args: string[],
  options: {
    input?: string;
    timeout?: number;
    cwd?: string;
    signal?: AbortSignal;
  } = {},
) {
  return new Promise<{ stdout: string; stderr: string; code: number | null }>(
    (resolve, reject) => {
      if (options.signal?.aborted) {
        reject(new Error("Отменено"));
        return;
      }
      const child = spawn(bin, args, {
        cwd: options.cwd || tmpdir(),
        env: childEnv(),
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
      });
      let stdout = "",
        stderr = "",
        settled = false;
      const kill = () => {
        try {
          if (child.pid) process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      };
      const finish = (error?: Error, code: number | null = null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        if (error) {
          kill();
          reject(error);
        } else resolve({ stdout, stderr, code });
      };
      const abort = () => finish(new Error("Отменено"));
      const timer = setTimeout(
        () => finish(new Error("Таймаут CLI. Задание можно повторить.")),
        options.timeout || 15000,
      );
      options.signal?.addEventListener("abort", abort, { once: true });
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
        if (stdout.length > 8 * 1024 * 1024)
          finish(new Error("Ответ CLI превышает 8 МБ"));
      });
      child.stderr.on("data", (chunk) => {
        stderr = (stderr + chunk.toString()).slice(-16000);
      });
      child.on("error", (error) => finish(error));
      child.on("close", (code) => finish(undefined, code));
      child.stdin.on("error", () => {});
      child.stdin.end(options.input || "");
    },
  );
}
export function configuredCodexModel() {
  try {
    return (
      readFileSync(
        join(
          process.env.CODEX_HOME || join(homedir(), ".codex"),
          "config.toml",
        ),
        "utf8",
      ).match(/^model\s*=\s*"([^"]+)"/m)?.[1] || ""
    );
  } catch {
    return "";
  }
}
export type ModelOption = { id: string; label: string; description: string };
// Codex keeps the models available to the subscription in its own cache; Claude CLI accepts stable aliases.
export function modelOptions(): Record<"codex" | "claude", ModelOption[]> {
  let codex: ModelOption[] = [];
  try {
    const cache = JSON.parse(
      readFileSync(
        join(process.env.CODEX_HOME || join(homedir(), ".codex"), "models_cache.json"),
        "utf8",
      ),
    );
    codex = (cache.models || [])
      .filter((m: any) => m.visibility === "list" && m.slug)
      .sort((a: any, b: any) => (a.priority ?? 99) - (b.priority ?? 99))
      .map((m: any) => ({ id: m.slug, label: m.display_name || m.slug, description: m.description || "" }));
  } catch {}
  const configured = configuredCodexModel();
  if (configured && !codex.some((m) => m.id === configured))
    codex.unshift({ id: configured, label: configured, description: "Из config.toml" });
  return {
    codex,
    claude: [
      { id: "opus", label: "Claude Opus", description: "Самая сильная, медленнее" },
      { id: "sonnet", label: "Claude Sonnet", description: "Баланс качества и скорости" },
      { id: "haiku", label: "Claude Haiku", description: "Быстрая и экономная" },
    ],
  };
}
export async function detectHarness(
  id: "codex" | "claude",
): Promise<HarnessInfo> {
  const bin = findBinary(id);
  const result: HarnessInfo = {
    id,
    installed: !!bin,
    ready: false,
    version: "",
    authMethod: "",
    note: "",
    model: id === "codex" ? configuredCodexModel() : "",
  };
  if (!bin) {
    result.note = `Установите ${id === "codex" ? "Codex CLI" : "Claude Code"}`;
    return result;
  }
  try {
    const v = await runProcess(bin, ["--version"]);
    result.version = v.stdout.trim();
    const auth = await runProcess(
      bin,
      id === "codex" ? ["login", "status"] : ["auth", "status", "--json"],
    );
    if (id === "codex") {
      result.ready =
        auth.code === 0 && /ChatGPT/i.test(auth.stdout + auth.stderr);
      result.authMethod = result.ready
        ? "Подписка ChatGPT"
        : "Не подтверждена подписка";
    } else {
      const a = JSON.parse(auth.stdout);
      result.ready =
        auth.code === 0 &&
        a.loggedIn === true &&
        /claude|oauth/i.test(a.authMethod || "");
      result.authMethod = result.ready
        ? "Подписка Claude"
        : "Не подтверждена подписка";
    }
    result.note = result.ready
      ? "Готов к анализу"
      : process.env.HACKALEM_CONTAINER
        ? `Вход с хоста в контейнер не переносится. Выполните: docker compose exec hackalem ${id === "codex" ? "codex login --device-auth" : "claude auth login"}`
        : `Выполните ${id === "codex" ? "codex login" : "claude auth login"} в терминале`;
  } catch {
    result.note = "Не удалось проверить CLI";
  }
  return result;
}
export function agentMessage(line: string) {
  try {
    const event = JSON.parse(line);
    const msg = event.msg ?? event;
    if (msg.type === "agent_message") return msg.message as string;
    if (msg.type === "item.completed" && msg.item?.type === "agent_message")
      return msg.item.text as string;
  } catch {}
  return undefined;
}
export function classifyFailure(text: string) {
  if (
    /usage.limit|rate.limit|quota|limit.reached|limit.exceeded|out.of.usage|hit.your.limit|insufficient_quota/i.test(
      text,
    )
  )
    return "limit";
  if (
    /unauthorized|authentication|login.required|not.logged.in|token.expired|invalid.api.key/i.test(
      text,
    )
  )
    return "auth";
  return "error";
}
export function codexArgs(system: string, model: string, reasoning: "low" | "medium" = "medium") {
  const args = [
    "exec",
    "--ephemeral",
    "--json",
    "--skip-git-repo-check",
    "--ignore-user-config",
    "--ignore-rules",
    "-s",
    "read-only",
    "-c",
    'approval_policy="never"',
    "-c",
    'web_search="disabled"',
    "-c",
    `model_reasoning_effort="${reasoning}"`,
    "-c",
    `developer_instructions=${JSON.stringify(system)}`,
  ];
  for (const flag of [
    "shell_tool",
    "plugins",
    "apps",
    "hooks",
    "multi_agent",
    "multi_agent_v2",
    "code_mode",
    "code_mode_host",
    "browser_use",
    "computer_use",
    "in_app_browser",
    "image_generation",
    "memories",
    "goals",
    "skill_search",
  ])
    args.push("-c", `features.${flag}=false`);
  if (model) args.push("-m", model);
  args.push("-");
  return args;
}
// ponytail: in-process semaphore; the limit is re-read on every acquire so the UI setting applies live.
let running = 0;
const waiting: (() => void)[] = [];
async function acquire(signal?: AbortSignal) {
  while (running >= Math.max(1, setting("concurrency", 3))) {
    signal?.throwIfAborted();
    await new Promise<void>((r) => {
      waiting.push(r);
      // Wake periodically too: the limit may be raised while we wait.
      setTimeout(r, 1000);
    });
  }
  running++;
}
function release() {
  running--;
  waiting.splice(0).forEach((r) => r());
}
// Only positive readiness is cached: a failed check must be re-run next time.
const readyAt = new Map<string, number>();
export async function oneShot(options: {
  harness: "codex" | "claude";
  model?: string;
  system: string;
  prompt: string;
  signal?: AbortSignal;
  timeout?: number;
  reasoning?: "low" | "medium";
}) {
  const bin = findBinary(options.harness);
  if (!bin)
    throw new PauseError(
      "Выбранный CLI не установлен. Откройте настройки.",
      "auth",
    );
  const readyKey = options.harness + ":" + bin;
  if (Date.now() - (readyAt.get(readyKey) || 0) > 60000) {
    const readiness = await detectHarness(options.harness);
    if (!readiness.ready) throw new PauseError(readiness.note, "auth");
    readyAt.set(readyKey, Date.now());
  }
  const model =
    options.model ||
    (options.harness === "codex" ? configuredCodexModel() : "");
  await acquire(options.signal);
  const cwd = mkdtempSync(join(tmpdir(), "hackalem-ai-"));
  try {
    const args =
      options.harness === "codex"
        ? codexArgs(options.system, model, options.reasoning)
        : [
            "-p",
            "--safe-mode",
            "--no-session-persistence",
            "--strict-mcp-config",
            "--tools",
            "",
            "--max-turns",
            "1",
            "--output-format",
            "json",
            "--system-prompt",
            options.system,
            ...(model ? ["--model", model] : []),
          ];
    const out = await runProcess(bin, args, {
      input: options.prompt,
      timeout: options.timeout || 240000,
      cwd,
      signal: options.signal,
    });
    let text = "";
    let actualModel = model;
    if (options.harness === "codex")
      for (const line of out.stdout.split("\n")) {
        const message = agentMessage(line);
        if (message) text = message;
      }
    else {
      try {
        const envelope = JSON.parse(out.stdout);
        if (envelope.is_error) throw new Error(envelope.result);
        text = envelope.result || "";
        actualModel = Object.keys(envelope.modelUsage || {})[0] || model;
      } catch {
        if (out.code === 0 && !out.stdout.trim().startsWith("{"))
          text = out.stdout.trim();
      }
    }
    if (out.code !== 0 || !text) {
      const kind = classifyFailure(out.stderr + out.stdout);
      if (kind === "auth") readyAt.delete(readyKey);
      if (kind !== "error")
        throw new PauseError(
          kind === "limit"
            ? "Лимит подписки. Очередь приостановлена; продолжите после сброса."
            : "Авторизация CLI истекла. Войдите через терминал.",
          kind,
        );
      throw new Error(
        `CLI завершился без результата (код ${out.code}). Проверьте модель и доступность подписки.`,
      );
    }
    return {
      text,
      model: actualModel || "По умолчанию CLI",
      harness: options.harness,
    };
  } finally {
    release();
    rmSync(cwd, { recursive: true, force: true });
  }
}
// Models quoting code sometimes leave a double quote or a line break unescaped inside a string.
// When the parser stops right after a string, the quote that closed it early is escaped; a raw
// control character is escaped in place. The schema check still guards the repaired value.
// ponytail: blind to intent; a genuinely missing comma gets "repaired" into a string and then
// fails the schema, which retries the call as before.
function parseRepaired(text: string): unknown {
  let s = text,
    first: unknown;
  for (let n = 0; n <= 50; n++) {
    try {
      return JSON.parse(s);
    } catch (error) {
      first ??= error;
      const message = (error as Error).message;
      const control = /Bad control character in string literal in JSON at position (\d+)/.exec(message);
      const early = /Expected ',' or '[}\]]' after (?:property value|array element) in JSON at position (\d+)/.exec(message);
      if (control) {
        const i = Number(control[1]);
        s = s.slice(0, i) + JSON.stringify(s[i]).slice(1, -1) + s.slice(i + 1);
      } else if (early && s.lastIndexOf('"', Number(early[1]) - 1) > 0) {
        const i = s.lastIndexOf('"', Number(early[1]) - 1);
        s = s.slice(0, i) + "\\" + s.slice(i);
      } else break;
    }
  }
  throw first;
}
export function jsonAnswer(text: string): unknown {
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*/, "")
    .replace(/\s*```$/, "");
  try {
    return parseRepaired(stripped);
  } catch (error) {
    // Models sometimes add prose before or after the JSON: take the first complete object.
    const start = stripped.indexOf("{");
    if (start < 0) throw error;
    let depth = 0,
      inString = false;
    for (let i = start; i < stripped.length; i++) {
      const c = stripped[i];
      if (inString) {
        if (c === "\\") i++;
        else if (c === '"') inString = false;
      } else if (c === '"') inString = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) return parseRepaired(stripped.slice(start, i + 1));
    }
    throw error;
  }
}

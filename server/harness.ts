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
  const readiness = await detectHarness(options.harness);
  if (!readiness.ready) throw new PauseError(readiness.note, "auth");
  const model =
    options.model ||
    (options.harness === "codex" ? configuredCodexModel() : "");
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
    rmSync(cwd, { recursive: true, force: true });
  }
}
export function jsonAnswer(text: string): unknown {
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*/, "")
    .replace(/\s*```$/, "");
  return JSON.parse(stripped);
}

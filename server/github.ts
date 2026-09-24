import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import tar from "tar-stream";
import { db, enqueue, getProject, indexProject, now, progress, HACKATHON_START, HACKATHON_END } from "./db.js";
import type { SourceFile, Snapshot } from "../shared/types.js";
const exec = promisify(execFile);
export class PauseError extends Error {
  constructor(
    message: string,
    public kind = "limit",
  ) {
    super(message);
  }
}
let tokenPromise: Promise<string> | null = null;
async function githubToken() {
  return (tokenPromise ??= exec("gh", ["auth", "token"], { timeout: 5000 })
    .then((r) => r.stdout.trim())
    .catch(() => process.env.GITHUB_TOKEN || ""));
}
// Shared GitHub request loop: auth, rate-limit pauses, retries on network errors and 5xx.
async function githubFetch(url: string, init: RequestInit, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const token = await githubToken();
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "HackAlem-local-catalog",
    ...(init.headers as Record<string, string>),
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        headers,
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
          : AbortSignal.timeout(30000),
      });
    } catch (error) {
      // Network error or timeout: retry like a 5xx, but never retry a cancellation.
      signal?.throwIfAborted();
      if (attempt === 2) throw error;
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      continue;
    }
    if (
      response.status === 429 ||
      (response.status === 403 &&
        response.headers.get("x-ratelimit-remaining") === "0")
    )
      throw new PauseError(
        "Лимит GitHub API. Продолжите импорт после восстановления квоты.",
        "github",
      );
    if (response.status === 401) {
      tokenPromise = null;
      throw new PauseError(
        "Авторизация GitHub истекла. Выполните gh auth login и продолжите.",
        "auth",
      );
    }
    if (response.status >= 500 && attempt < 2) {
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      continue;
    }
    return response;
  }
  throw new Error("GitHub временно недоступен");
}
export async function github(path: string, signal?: AbortSignal) {
  const response = await githubFetch(`https://api.github.com${path}`, {}, signal);
  if (response.status === 409) return null;
  if (!response.ok)
    throw new Error(`GitHub: HTTP ${response.status} для ${path}`);
  return response.json();
}
export async function githubGraphql(query: string, signal?: AbortSignal) {
  const response = await githubFetch(
    "https://api.github.com/graphql",
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query }) },
    signal,
  );
  if (!response.ok) throw new Error(`GitHub GraphQL: HTTP ${response.status}`);
  const body = (await response.json()) as { data?: any; errors?: { message: string }[] };
  if (!body.data) throw new Error(`GitHub GraphQL: ${body.errors?.[0]?.message || "пустой ответ"}`);
  return body.data;
}
// Commit rhythm during the hackathon (default branch): commits before the start, in each of the
// five hours, and after the end. The org's auto-created first commit is not counted as team work.
// Repos are archived, so the numbers are fetched once per project.
export async function fetchCommitStats(jobId: number, signal?: AbortSignal) {
  const pending = db
    .prepare(`SELECT id,name FROM projects p WHERE commit_stats IS NULL AND coalesce(pushed_at,updated_at)>=?`)
    .all(HACKATHON_START) as { id: number; name: string }[];
  const start = Date.parse(HACKATHON_START);
  const hour = (h: number) => new Date(start + h * 3600000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const history = (alias: string, range: string) => `${alias}: history(${range}) { totalCount }`;
  for (let i = 0; i < pending.length; i += 25) {
    const batch = pending.slice(i, i + 25);
    const query = `query {${batch
      .map(
        (p, k) => `r${k}: repository(owner: "BAITC-Hacks", name: ${JSON.stringify(p.name)}) { defaultBranchRef { target { ... on Commit {
          ${history("before", `until: "${HACKATHON_START}"`)}
          ${history("after", `since: "${HACKATHON_END}"`)}
          ${[0, 1, 2, 3, 4].map((h) => history(`h${h}`, `since: "${hour(h)}", until: "${hour(h + 1)}"`)).join("\n")}
        } } } }`,
      )
      .join("\n")}}`;
    const data = await githubGraphql(query, signal);
    db.transaction(() => {
      batch.forEach((p, k) => {
        const c = data[`r${k}`]?.defaultBranchRef?.target;
        if (!c) return;
        const hours = [0, 1, 2, 3, 4].map((h) => c[`h${h}`].totalCount as number);
        const stats = {
          before: Math.max(0, c.before.totalCount - 1),
          window: hours.reduce((a, b) => a + b, 0),
          after: c.after.totalCount,
          hours,
        };
        db.prepare("UPDATE projects SET commit_stats=? WHERE id=?").run(JSON.stringify(stats), p.id);
      });
    })();
    progress(jobId, `Статистика коммитов · ${Math.min(i + 25, pending.length)}/${pending.length}`);
  }
  return pending.length;
}
export async function syncOrganization(
  jobId: number,
  limit?: number,
  signal?: AbortSignal,
) {
  let count = 0,
    page = 1;
  const seen = new Set<number>();
  while (true) {
    const rows = await github(
      `/orgs/BAITC-Hacks/repos?type=public&per_page=100&page=${page}&sort=full_name`,
      signal,
    );
    if (!Array.isArray(rows))
      throw new Error("GitHub не вернул список репозиториев");
    for (const r of rows) {
      signal?.throwIfAborted();
      if (r.private || seen.has(r.id)) continue;
      seen.add(r.id);
      if (limit && count >= limit) break;
      db.prepare(
        `INSERT INTO projects(id,name,full_name,team,description,url,branch,language,size,archived,updated_at,pushed_at,synced_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,full_name=excluded.full_name,team=excluded.team,description=excluded.description,url=excluded.url,branch=excluded.branch,language=excluded.language,size=excluded.size,archived=excluded.archived,updated_at=excluded.updated_at,pushed_at=excluded.pushed_at,synced_at=excluded.synced_at`,
      ).run(
        r.id,
        r.name,
        r.full_name,
        (r.description || "").replace(/^Hackathon team repository for /, "") ||
          r.name,
        r.description || "",
        r.html_url,
        r.default_branch,
        r.language,
        r.size,
        r.archived ? 1 : 0,
        r.updated_at,
        r.pushed_at ?? null,
        now(),
      );
      indexProject(r.id);
      enqueue("snapshot", r.id);
      count++;
    }
    progress(jobId, `Обнаружено ${count} репозиториев · страница ${page}`);
    if (rows.length < 100 || (limit && count >= limit)) break;
    page++;
  }
  // Commit stats are auxiliary: a GraphQL failure must not fail the repository import.
  let commitStats: number | string = 0;
  try {
    commitStats = await fetchCommitStats(jobId, signal);
  } catch (error) {
    if (signal?.aborted || error instanceof PauseError) throw error;
    commitStats = (error as Error).message;
  }
  return { count, pages: page, commitStats };
}
export function skipReason(path: string, size: number): string | null {
  if (
    /(^|\/)(node_modules|vendor|\.git|\.next|dist|build|coverage|venv|\.venv|__pycache__|\.cache|target|Pods)(\/|$)/i.test(
      path,
    )
  )
    return "Зависимости или сборка";
  if (
    /(^|\/)(\.env($|\.)|credentials|secrets?\.)/i.test(path) &&
    !/^\.env\.(?:.*\.)?(example|sample|template)$/i.test(
      path.split("/").at(-1) || "",
    )
  )
    return "Файл с потенциальными секретами";
  if (
    /(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|uv\.lock|poetry\.lock|\.min\.(js|css)|\.map)$/i.test(
      path,
    )
  )
    return "Сгенерированный файл";
  if (size > 300000) return "Файл больше 300 КБ";
  if (
    !/(\.(md|mdx|txt|py|ts|tsx|js|jsx|mjs|cjs|json|yaml|yml|toml|ini|cfg|rs|go|java|kt|kts|swift|c|h|cpp|hpp|cs|php|rb|sql|sh|html|css|scss|vue|svelte|dart|r|ipynb)|(^|\/)(Dockerfile|Makefile|LICENSE|README|Procfile|\.gitignore|\.dockerignore|\.python-version|\.nvmrc|\.tool-versions|\.editorconfig|\.env\.(?:.*\.)?(?:example|sample|template)))$/i.test(
      path,
    )
  )
    return "Данные или двоичный формат";
  return null;
}
export async function readArchive(response: Response, signal?: AbortSignal) {
  if (!response.body) throw new Error("Пустой архив");
  const tree: Snapshot["tree"] = [],
    files: SourceFile[] = [];
  const extractor = tar.extract();
  let compressed = 0,
    total = 0,
    selected = 0;
  const limiter = new Transform({
    transform(chunk, _, callback) {
      compressed += chunk.length;
      callback(
        compressed > 30 * 1024 * 1024
          ? new Error("Архив больше лимита 30 МБ")
          : null,
        chunk,
      );
    },
  });
  extractor.on("entry", (header, stream, next) => {
    // tar-stream emits errors on the current entry as well as the extractor.
    // Forward them to the pipeline so cancellation cannot crash the worker.
    stream.on("error", (error) => extractor.destroy(error));
    const path = header.name.split("/").slice(1).join("/");
    const bytes = header.size || 0;
    total += bytes;
    if (total > 100 * 1024 * 1024 || tree.length > 30000) {
      extractor.destroy(
        new Error("Архив превышает лимит распаковки 100 МБ / 30000 файлов"),
      );
      stream.resume();
      return;
    }
    if (!path || header.type === "directory") {
      stream.on("end", next);
      stream.resume();
      return;
    }
    let reason =
      path.split("/").includes("..") || path.startsWith("/")
        ? "Недопустимый путь"
        : header.type !== "file"
          ? "Ссылка или специальный файл"
          : skipReason(path, bytes);
    if (!reason && (selected + bytes > 12 * 1024 * 1024 || files.length >= 600))
      reason = "Лимит снимка: 12 МБ / 600 исходных файлов";
    const item = { path, bytes, ...(reason ? { reason } : {}) };
    tree.push(item);
    if (reason) {
      stream.on("end", next);
      stream.resume();
      return;
    }
    const chunks: Buffer[] = [];
    stream.on("data", (chunk) => chunks.push(Buffer.from(chunk as Uint8Array)));
    stream.on("end", () => {
      const buffer = Buffer.concat(chunks);
      if (buffer.includes(0)) item.reason = "Двоичный файл";
      else {
        const text = buffer.toString("utf8");
        selected += buffer.length;
        files.push({
          path,
          text,
          bytes: buffer.length,
          lines: text.split("\n").length,
        });
      }
      next();
    });
  });
  await pipeline(
    Readable.fromWeb(response.body as any),
    limiter,
    createGunzip(),
    extractor,
    { signal },
  );
  return { tree, files };
}
export async function readTreeSources(
  fullName: string,
  sha: string,
  signal?: AbortSignal,
) {
  const result = await github(
    `/repos/${fullName}/git/trees/${sha}?recursive=1`,
    signal,
  );
  if (!Array.isArray(result?.tree))
    throw new Error("GitHub не вернул дерево файлов");
  const tree: Snapshot["tree"] = [];
  const files: SourceFile[] = [];
  let selectedBytes = 0;
  const selected: { path: string; bytes: number; reason?: string }[] = [];
  const entries = result.tree
    .filter((e: any) => e.type !== "tree")
    .sort(
      (a: any, b: any) =>
        Number(/(^|\/)readme/i.test(b.path)) -
          Number(/(^|\/)readme/i.test(a.path)) || a.path.localeCompare(b.path),
    );
  for (const entry of entries) {
    const path = String(entry.path);
    const bytes = Number(entry.size || 0);
    let reason =
      path.split("/").includes("..") || path.startsWith("/")
        ? "Недопустимый путь"
        : entry.type !== "blob" || entry.mode === "120000"
          ? "Ссылка или специальный файл"
          : skipReason(path, bytes);
    if (
      !reason &&
      (selected.length >= 600 || selectedBytes + bytes > 12 * 1024 * 1024)
    )
      reason = "Лимит снимка: 12 МБ / 600 исходных файлов";
    const item = { path, bytes, ...(reason ? { reason } : {}) };
    tree.push(item);
    if (!reason) {
      selected.push(item);
      selectedBytes += bytes;
    }
  }
  if (result.truncated)
    tree.push({
      path: "[дерево GitHub усечено]",
      bytes: 0,
      reason: "GitHub вернул неполное дерево: покрытие проекта ограничено",
    });
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(6, selected.length) }, async () => {
      while (next < selected.length) {
        signal?.throwIfAborted();
        const item = selected[next++];
        try {
          const response = await fetch(
            `https://raw.githubusercontent.com/${fullName}/${sha}/${item.path.split("/").map(encodeURIComponent).join("/")}`,
            {
              signal: signal
                ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
                : AbortSignal.timeout(30000),
            },
          );
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const buffer = Buffer.from(await response.arrayBuffer());
          if (buffer.length > 300000) item.reason = "Файл больше 300 КБ";
          else if (buffer.includes(0)) item.reason = "Двоичный файл";
          else {
            const text = buffer.toString("utf8");
            files.push({
              path: item.path,
              text,
              bytes: buffer.length,
              lines: text.split("\n").length,
            });
          }
        } catch (error) {
          if (signal?.aborted) throw error;
          item.reason = "Ошибка загрузки файла: " + (error as Error).message;
        }
      }
    }),
  );
  if (selected.length && !files.length)
    throw new Error("Не удалось загрузить ни один исходный файл");
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { tree, files };
}
export async function snapshotProject(
  jobId: number,
  id: number,
  signal?: AbortSignal,
) {
  const p = getProject(id);
  if (!p) throw new Error("Проект не найден");
  const job = db.prepare("SELECT payload FROM jobs WHERE id=?").get(jobId) as {payload:string} | undefined;
  const fullRequested = job && JSON.parse(job.payload).mode === "full";
  const queueAnalysis = () => {
    const payload = fullRequested ? {mode:"full",priority:-10} : {};
    enqueue("analyze", id, payload);
    if (fullRequested) db.prepare("UPDATE jobs SET payload=json_set(payload,'$.mode','full','$.priority',-10) WHERE type='analyze' AND project_id=? AND state='queued'").run(id);
  };
  progress(jobId, `Чтение ${p.team}`);
  const commit = await github(
    `/repos/${p.fullName}/commits/${encodeURIComponent(p.branch)}`,
    signal,
  );
  if (!commit) {
    db.prepare(
      "UPDATE projects SET status='empty',error=NULL,synced_at=? WHERE id=?",
    ).run(now(), id);
    return { empty: true };
  }
  const sha = commit.sha as string;
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("Некорректный commit SHA");
  db.prepare("UPDATE quick_reviews SET stale=1 WHERE project_id=? AND source_id IN (SELECT id FROM readme_sources WHERE project_id=? AND sha!=?)").run(id,id,sha);
  const existing = db
    .prepare("SELECT id FROM snapshots WHERE project_id=? AND sha=?")
    .get(id, sha) as { id: number } | undefined;
  if (existing) {
    if (p.snapshotId !== existing.id)
      db.prepare("UPDATE analyses SET stale=1 WHERE project_id=?").run(id);
    db.prepare(
      "UPDATE projects SET snapshot_id=?,sha=?,synced_at=?,error=NULL,status=CASE WHEN status='error' OR snapshot_id!=? THEN CASE WHEN (SELECT readme_path FROM snapshots WHERE id=?) IS NULL THEN 'no_readme' ELSE 'ready' END ELSE status END WHERE id=?",
    ).run(existing.id, sha, now(), existing.id, existing.id, id);
    indexProject(id);
    const a = db
      .prepare(
        "SELECT id FROM analyses WHERE project_id=? AND snapshot_id=? AND stale=0",
      )
      .get(id, existing.id);
    if (!a) queueAnalysis();
    return { unchanged: true };
  }
  let sources: Awaited<ReturnType<typeof readArchive>>;
  if (p.size > 30000) sources = await readTreeSources(p.fullName, sha, signal);
  else
    try {
      const response = await fetch(
        `https://codeload.github.com/${p.fullName}/tar.gz/${sha}`,
        {
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(90000)])
            : AbortSignal.timeout(90000),
        },
      );
      if (!response.ok)
        throw new Error(`Архив GitHub: HTTP ${response.status}`);
      sources = await readArchive(response, signal);
    } catch (error) {
      signal?.throwIfAborted();
      progress(jobId, `Чтение отдельных файлов · ${p.team}`);
      sources = await readTreeSources(p.fullName, sha, signal);
    }
  const { tree, files } = sources;
  signal?.throwIfAborted();
  const readmes = files.filter((f) =>
    /(^|\/)readme(?:\.[^/]*)?$/i.test(f.path),
  );
  readmes.sort(
    (a, b) =>
      a.path.split("/").length - b.path.split("/").length ||
      a.path.length - b.path.length,
  );
  const readme = readmes[0];
  const snapshotId = db.transaction(() => {
    const r = db
      .prepare(
        "INSERT INTO snapshots(project_id,sha,readme_path,readme,tree,created_at) VALUES(?,?,?,?,?,?)",
      )
      .run(
        id,
        sha,
        readme?.path ?? null,
        readme?.text ?? "",
        JSON.stringify(tree),
        now(),
      );
    const sid = Number(r.lastInsertRowid);
    const insert = db.prepare("INSERT INTO source_files VALUES(?,?,?,?,?)");
    for (const f of files) insert.run(sid, f.path, f.text, f.bytes, f.lines);
    db.prepare("UPDATE analyses SET stale=1 WHERE project_id=?").run(id);
    db.prepare(
      "UPDATE projects SET snapshot_id=?,sha=?,status=?,error=NULL,synced_at=? WHERE id=?",
    ).run(sid, sha, readme ? "ready" : "no_readme", now(), id);
    return sid;
  })();
  indexProject(id);
  queueAnalysis();
  return {
    snapshotId,
    files: files.length,
    skipped: tree.filter((x) => x.reason).length,
  };
}

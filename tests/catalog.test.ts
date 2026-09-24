import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { randomBytes } from "node:crypto";
import tar from "tar-stream";
const directory = mkdtempSync(join(tmpdir(), "hackalem-tests-"));
process.env.HACKALEM_DATA_DIR = directory;
process.env.NODE_ENV = "test";
const {
  db,
  enqueue,
  getProject,
  getSnapshot,
  indexProject,
  setSetting,
  setting,
} = await import("../server/db.js");
const {
  skipReason,
  readArchive,
  syncOrganization,
  snapshotProject,
  PauseError,
  github,
} = await import("../server/github.js");
const { sourceChunks, validateEvidence, validateScores, rankProjects } =
  await import("../server/analysis.js");
const { tracks, commonRubric } = await import("../server/tracks.js");
const { listProjects, csvCell, rankings } = await import(
  "../server/catalog.js"
);
const { agentMessage, classifyFailure, codexArgs, runProcess, jsonAnswer } =
  await import("../server/harness.js");
const { app } = await import("../server/index.js");
let server: ReturnType<typeof app.listen>,
  base = "";
beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(async () => {
  vi.restoreAllMocks();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
  rmSync(directory, { recursive: true, force: true });
});
function repo(id: number) {
  return {
    id,
    name: `hack-${id}-team`,
    full_name: `BAITC-Hacks/hack-${id}-team`,
    description: `Hackathon team repository for Команда ${id}`,
    html_url: `https://github.com/BAITC-Hacks/hack-${id}-team`,
    default_branch: "main",
    language: "Python",
    size: 10,
    archived: true,
    updated_at: "2026-09-23T12:00:00Z",
  };
}
async function archive(files: { name: string; text: string; type?: string }[]) {
  const pack = tar.pack();
  const chunks: Buffer[] = [];
  const collected = new Promise<Buffer>((resolve) => {
    pack.on("data", (b) => chunks.push(Buffer.from(b as Uint8Array)));
    pack.on("end", () => resolve(gzipSync(Buffer.concat(chunks))));
  });
  for (const f of files)
    pack.entry(
      { name: "root/" + f.name, type: (f.type || "file") as any },
      f.type ? "" : f.text,
    );
  pack.finalize();
  return new Response((await collected) as any);
}
describe("GitHub collection", () => {
  it("imports more than one page, resumes without duplicates, queues idempotently", async () => {
    const mock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(
        async (url) =>
          new Response(
            JSON.stringify(
              String(url).includes("page=2")
                ? [repo(101)]
                : Array.from({ length: 100 }, (_, i) => repo(i + 1)),
            ),
          ),
      );
    expect(await syncOrganization(0)).toEqual({ count: 101, pages: 2 });
    expect(mock).toHaveBeenCalledTimes(2);
    await syncOrganization(0);
    expect((db.prepare("SELECT count(*) n FROM projects").get() as any).n).toBe(
      101,
    );
    expect((db.prepare("SELECT count(*) n FROM jobs").get() as any).n).toBe(
      101,
    );
    mock.mockRestore();
  });
  it("reads a bounded archive, ignores traversal, dependencies, secrets and binary files", async () => {
    const response = await archive([
      { name: "README.md", text: "# Проект" },
      { name: "src/main.py", text: "print(1)" },
      { name: "node_modules/lib/x.js", text: "alert(1)" },
      { name: "../outside.py", text: "bad" },
      { name: ".env", text: "SECRET=x" },
      { name: "binary.py", text: "a\0b" },
      { name: "link.py", text: "", type: "symlink" },
    ]);
    const result = await readArchive(response);
    expect(result.files.map((f) => f.path)).toEqual([
      "README.md",
      "src/main.py",
    ]);
    expect(result.tree.filter((f) => f.reason)).toHaveLength(5);
  });
  it("keeps an empty repo without an invented README or score", async () => {
    const mock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 409 }));
    await snapshotProject(0, 1);
    expect(getProject(1)?.status).toBe("empty");
    expect(getProject(1)?.snapshotId).toBeNull();
    mock.mockRestore();
  });
  it("saves missing README and reuses unchanged snapshot", async () => {
    const sha = "a".repeat(40);
    const mock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (url) =>
        String(url).includes("api.github")
          ? new Response(JSON.stringify({ sha }))
          : archive([{ name: "main.py", text: "def run():\n    return 42\n" }]),
      );
    await snapshotProject(0, 2);
    const p = getProject(2)!;
    expect(p.status).toBe("no_readme");
    expect(getSnapshot(p.snapshotId!)?.files[0].lines).toBe(3);
    const result = await snapshotProject(0, 2);
    expect(result).toEqual({ unchanged: true });
    expect(mock).toHaveBeenCalledTimes(3);
    mock.mockRestore();
  });
  it("pauses on quota and never invents a failed score", async () => {
    const mock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", {
        status: 403,
        headers: { "x-ratelimit-remaining": "0" },
      }),
    );
    await expect(github("/test")).rejects.toBeInstanceOf(PauseError);
    mock.mockRestore();
  });
  it("marks oversized and generated files as omitted", () => {
    expect(skipReason("x.py", 300001)).toContain("300");
    expect(skipReason("package-lock.json", 40)).toContain("Сгенерированный");
    expect(skipReason("notes.md", 10)).toBeNull();
    expect(skipReason("examples/.env", 10)).toContain("секретами");
    expect(skipReason(".env.example", 10)).toBeNull();
  });
});
describe("retrieval and scoring", () => {
  it("finds Russian and English terms and resists FTS syntax", () => {
    db.prepare(
      "UPDATE projects SET summary='Прогнозирование ветра forecasting',technologies='[\"FastAPI\"]',track_id=1 WHERE id=3",
    ).run();
    indexProject(3);
    expect(listProjects({ q: "ветр", track: 1 }).items[0].id).toBe(3);
    expect(
      listProjects({ q: "forecast", technology: "FastAPI" }).items[0].id,
    ).toBe(3);
    expect(() => listProjects({ q: '\" OR * ) NEAR' })).not.toThrow();
  });
  it("uses distinct per-case rubric and relevant constraints", () => {
    expect(tracks).toHaveLength(12);
    expect(tracks[6].rubric.map((r) => r.max)).toEqual([
      20, 15, 25, 15, 10, 10, 5,
    ]);
    expect(tracks[4].rubricOrigin).toBe("analytical");
    expect(tracks[9].rubricOrigin).toBe("analytical");
    expect(tracks[2].spec).toContain("Геймификация является надстройкой");
    expect(tracks[8].spec).toContain("но не являются условием сдачи");
    expect(
      tracks[7].requirements.some((r) =>
        r.text.includes("внешние облачные API запрещена"),
      ),
    ).toBe(true);
    expect(tracks.every((t) => t.requirements.length > 0)).toBe(true);
  });
  it("rejects hallucinated file paths, line ranges and quotes", () => {
    const files = [
      {
        path: "main.py",
        text: "def run():\n    return 42",
        lines: 2,
        bytes: 26,
      },
    ];
    const proof = { path: "main.py", start: 2, end: 2, quote: "return 42" };
    expect(() => validateEvidence([proof], files)).not.toThrow();
    expect(() =>
      validateEvidence([{ ...proof, path: "secret.py" }], files),
    ).toThrow();
    expect(() => validateEvidence([{ ...proof, end: 3 }], files)).toThrow();
    expect(() =>
      validateEvidence([{ ...proof, quote: "return 100" }], files),
    ).toThrow();
  });
  it("validates maximums, missing criteria and evidence before calculating totals", () => {
    const rubric = [{ id: "fit", title: "Fit", max: 25 }],
      files = [{ path: "a", text: "works", lines: 1, bytes: 5 }],
      scores = [
        {
          id: "fit",
          points: 20,
          rationale: "reason",
          evidence: [{ path: "a", start: 1, end: 1, quote: "works" }],
        },
      ];
    expect(validateScores(scores, rubric, files)).toBe(20);
    expect(() =>
      validateScores([{ ...scores[0], points: 26 }], rubric, files),
    ).toThrow();
    expect(() =>
      validateScores([{ ...scores[0], evidence: [] }], rubric, files),
    ).toThrow();
    expect(() => validateScores([], rubric, files)).toThrow();
  });
  it("assigns equal ranks and excludes unprocessed projects", () => {
    expect(
      rankProjects([{ score: 90 }, { score: 90 }, { score: 80 }]).map(
        (x) => x.rank,
      ),
    ).toEqual([1, 1, 3]);
    expect(rankings()).toEqual([]);
  });
  it("preserves original line numbers and references exact duplicate blocks", () => {
    const content = Array.from({ length: 60 }, (_, i) => "line " + i).join(
      "\n",
    );
    const files = [
      { path: "first.py", text: content, lines: 60, bytes: content.length },
      {
        path: "second.py",
        text: content + "\nunique_new_line",
        lines: 61,
        bytes: content.length + 16,
      },
    ];
    const result = sourceChunks(files, 300).join("\n");
    expect(result).toContain("1: line 0");
    expect(result).toContain("Точная копия first.py:1-60");
    expect(result).toContain("61: unique_new_line");
  });
  it("protects spreadsheet exports against formula injection", () => {
    expect(csvCell("=1+1")).toBe('"\'=1+1"');
    expect(csvCell('a"b')).toBe('"a""b"');
  });
});
describe("CLI boundaries", () => {
  it("parses both supported JSONL shapes and strict JSON", () => {
    expect(
      agentMessage(
        '{"type":"item.completed","item":{"type":"agent_message","text":"yes"}}',
      ),
    ).toBe("yes");
    expect(
      agentMessage('{"msg":{"type":"agent_message","message":"old"}}'),
    ).toBe("old");
    expect(agentMessage("not json")).toBeUndefined();
    expect(jsonAnswer('```json\n{"ok":true}\n```')).toEqual({ ok: true });
    expect(() => jsonAnswer("an answer")).toThrow();
  });
  it("isolates config, disables tools and passes prompts via stdin", () => {
    const args = codexArgs("trusted", "model");
    expect(args).toContain("--ignore-user-config");
    expect(args).toContain("features.shell_tool=false");
    expect(args).toContain("features.plugins=false");
    expect(args).toContain("read-only");
    expect(args.at(-1)).toBe("-");
  });
  it("distinguishes subscription limits from auth failures", () => {
    expect(classifyFailure("usage limit reached")).toBe("limit");
    expect(classifyFailure("not logged in")).toBe("auth");
    expect(classifyFailure("network issue")).toBe("error");
  });
  it("times out and cancels child processes", async () => {
    await expect(
      runProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
        timeout: 30,
      }),
    ).rejects.toThrow("Таймаут");
    const controller = new AbortController();
    const p = runProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      signal: controller.signal,
    });
    controller.abort();
    await expect(p).rejects.toThrow("Отменено");
  });
});
describe("local API", () => {
  it("provides health, 12 tracks and direct project access", async () => {
    expect((await fetch(base + "/api/health")).status).toBe(200);
    expect((await (await fetch(base + "/api/tracks")).json()).length).toBe(12);
    expect(
      (await (await fetch(base + "/api/projects/2")).json()).project.id,
    ).toBe(2);
  });
  it("rejects cross-origin mutations and malformed payloads", async () => {
    expect(
      (
        await fetch(base + "/api/queue", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: '{"paused":true}',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(base + "/api/queue", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-HackAlem": "local",
            Origin: "https://evil.example",
          },
          body: '{"paused":true}',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(base + "/api/queue", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-HackAlem": "local",
          },
          body: '{"paused":"yes"}',
        })
      ).status,
    ).toBe(400);
  });
  it("persists pause/resume and validates comparison size", async () => {
    const send = (path: string, body: unknown) =>
      fetch(base + path, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-HackAlem": "local" },
        body: JSON.stringify(body),
      });
    await send("/api/queue", { paused: true });
    expect(setting("paused", false)).toBe(true);
    await send("/api/queue", { paused: false });
    expect(setting("paused", true)).toBe(false);
    expect((await send("/api/comparisons", { ids: [2] })).status).toBe(400);
    expect((await send("/api/comparisons", { ids: [2, 3] })).status).toBe(200);
  });
  it("can only read stored snapshot files, not arbitrary local paths", async () => {
    const p = getProject(2)!;
    expect(
      (await fetch(base + `/api/snapshots/${p.snapshotId}/file?path=main.py`))
        .status,
    ).toBe(200);
    expect(
      (
        await fetch(
          base +
            `/api/snapshots/${p.snapshotId}/file?path=../../.codex/auth.json`,
        )
      ).status,
    ).toBe(404);
  });
});

describe("analysis lifecycle", () => {
  it("persists validated stages, resumes from cache and rejects invented citations", async () => {
    const harness = await import("../server/harness.js");
    const { analyzeProject } = await import("../server/analysis.js");
    const proof = { path: "main.py", start: 2, end: 2, quote: "return 42" };
    const scores = commonRubric.map((c) => ({
      id: c.id,
      points: 1,
      rationale: "Подтверждена только функция",
      evidence: [proof],
    }));
    const final = {
      summary: "Контрольный проект",
      architecture: "Одна функция",
      aiUsage: "Не обнаружен",
      reproducibility: "Не запускался",
      technologies: ["Python"],
      strengths: ["Есть функция"],
      weaknesses: ["Нет модели"],
      expertQuestions: ["Проверить запуск"],
      findings: tracks[0].requirements.map((r) => ({
        requirementId: r.id,
        verdict: "unknown",
        explanation: "Не подтверждено",
        evidence: [],
      })),
      scores: [],
      commonScores: scores,
    };
    setSetting("model", "test-model");
    const replies = [
      { trackId: 1, candidates: [1], confidence: 0.9 },
      {
        summary: "Функция",
        observations: [
          { description: "Возвращает число", kind: "code", evidence: [proof] },
        ],
      },
      final,
    ];
    const mock = vi.spyOn(harness, "oneShot").mockImplementation(async () => ({
      text: JSON.stringify(replies.shift()),
      model: "test-model",
      harness: "codex",
    }));
    try {
      const controller = new AbortController();
      const result = await analyzeProject(0, 2, controller.signal);
      expect(result.commonTotal).toBe(5);
      expect(mock).toHaveBeenCalledTimes(3);
      expect(getProject(2)?.status).toBe("analyzed");
      const { restoreAnalysisState } = await import("../server/db.js");
      db.prepare("UPDATE projects SET status='analyzing' WHERE id=2").run();
      restoreAnalysisState(2);
      expect(getProject(2)?.status).toBe("analyzed");
      mock.mockClear();
      mock.mockResolvedValue({
        text: JSON.stringify(final),
        model: "test-model",
        harness: "codex",
      });
      await analyzeProject(0, 2, controller.signal);
      expect(mock).toHaveBeenCalledTimes(1);
      const before = (
        db.prepare("SELECT count(*) n FROM analyses").get() as any
      ).n;
      const invalid = {
        ...final,
        commonScores: scores.map((s) => ({
          ...s,
          evidence: [{ ...proof, path: "invented.py" }],
        })),
      };
      mock.mockResolvedValue({
        text: JSON.stringify(invalid),
        model: "test-model",
        harness: "codex",
      });
      await expect(analyzeProject(0, 2, controller.signal)).rejects.toThrow(
        "Неверная ссылка",
      );
      expect(
        (db.prepare("SELECT count(*) n FROM analyses").get() as any).n,
      ).toBe(before);
    } finally {
      mock.mockRestore();
      setSetting("model", "");
    }
  });
  it("marks old scores stale on a new commit and can restore an older snapshot", async () => {
    const original = getProject(2)!.snapshotId;
    let sha = "b".repeat(40);
    const mock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (url) =>
        String(url).includes("api.github")
          ? new Response(JSON.stringify({ sha }))
          : archive([
              { name: "README.md", text: "# New" },
              { name: "main.py", text: "return 50" },
            ]),
      );
    try {
      await snapshotProject(0, 2);
      expect(
        (
          db
            .prepare("SELECT count(*) n FROM analyses WHERE stale=0")
            .get() as any
        ).n,
      ).toBe(0);
      expect(rankings()).toHaveLength(0);
      sha = "a".repeat(40);
      await snapshotProject(0, 2);
      expect(getProject(2)!.snapshotId).toBe(original);
      expect(getProject(2)!.status).toBe("no_readme");
    } finally {
      mock.mockRestore();
    }
  });
  it("aborts an import before making a request", async () => {
    const controller = new AbortController();
    controller.abort();
    const mock = vi.spyOn(globalThis, "fetch");
    try {
      await expect(
        syncOrganization(0, undefined, controller.signal),
      ).rejects.toThrow();
      expect(mock).not.toHaveBeenCalled();
    } finally {
      mock.mockRestore();
    }
  });
  it("retains original specifications by content hash", async () => {
    const result = await fetch(base + "/api/specifications/" + tracks[6].hash);
    expect(result.status).toBe(200);
    expect((await result.json()).spec).toBe(tracks[6].spec);
  });
});

describe("subscription CLI failures", () => {
  async function fakeCodex(mode: string, run: () => Promise<void>) {
    const folder = mkdtempSync(join(tmpdir(), "hackalem-cli-"));
    const oldPath = process.env.PATH;
    writeFileSync(
      join(folder, "codex"),
      `#!${process.execPath}\nconst args=process.argv.slice(2);if(args.includes('--version'))console.log('test CLI');else if(args.includes('status'))console.log(${JSON.stringify(mode === "api" ? "Logged in using an API key" : "Logged in using ChatGPT")});else {${mode === "quota" ? "console.error('usage limit reached');process.exitCode=1;" : "console.log('invalid output');"}}\n`,
    );
    chmodSync(join(folder, "codex"), 0o755);
    process.env.PATH = folder + ":" + oldPath;
    try {
      await run();
    } finally {
      process.env.PATH = oldPath;
      rmSync(folder, { recursive: true, force: true });
    }
  }
  it("does not use an API-key login as subscription access", async () => {
    const { oneShot } = await import("../server/harness.js");
    await fakeCodex("api", async () => {
      await expect(
        oneShot({ harness: "codex", system: "test", prompt: "test" }),
      ).rejects.toBeInstanceOf(PauseError);
    });
  });
  it("turns subscription exhaustion into a resumable pause", async () => {
    const { oneShot } = await import("../server/harness.js");
    await fakeCodex("quota", async () => {
      await expect(
        oneShot({ harness: "codex", system: "test", prompt: "test" }),
      ).rejects.toThrow("Лимит подписки");
    });
  });
  it("does not accept a CLI response with no final model message", async () => {
    const { oneShot } = await import("../server/harness.js");
    await fakeCodex("invalid", async () => {
      await expect(
        oneShot({ harness: "codex", system: "test", prompt: "test" }),
      ).rejects.toThrow("без результата");
    });
  });
});

it("restores exact line wraps without accepting changed wording", () => {
  const proof = {
    path: "x.md",
    start: 1,
    end: 2,
    quote: "Точная цитата из источника",
  };
  const files = [
    { path: "x.md", text: "Точная цитата\nиз источника", lines: 2, bytes: 50 },
  ];
  validateEvidence([proof], files);
  expect(proof.quote).toBe(files[0].text);
  expect(() =>
    validateEvidence(
      [{ ...proof, quote: "Неточная цитата из источника" }],
      files,
    ),
  ).toThrow();
});

it("rejects empty or zero-line evidence and extracts only declared demo links", async () => {
  const files = [{ path: "x", text: "source", lines: 1, bytes: 6 }];
  expect(() =>
    validateEvidence([{ path: "x", start: 0, end: 1, quote: "source" }], files),
  ).toThrow();
  expect(() =>
    validateEvidence([{ path: "x", start: 1, end: 1, quote: "" }], files),
  ).toThrow();
  const { demoLinks } = await import("../server/catalog.js");
  expect(
    demoLinks(
      "[Demo](https://demo.example) [GitHub](https://github.com) [Демо](javascript:alert) [Live](https://demo.example)",
    ),
  ).toEqual(["https://demo.example"]);
});

it("loads bounded raw sources when a repository archive is too large", async () => {
  const { readTreeSources } = await import("../server/github.js");
  const sha = "c".repeat(40);
  const mock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    if (String(url).includes("api.github.com"))
      return new Response(
        JSON.stringify({
          truncated: true,
          tree: [
            { path: "README.md", type: "blob", mode: "100644", size: 10 },
            { path: "src/main.py", type: "blob", mode: "100644", size: 20 },
            { path: "src/broken.py", type: "blob", mode: "100644", size: 10 },
            { path: "data.csv", type: "blob", mode: "100644", size: 9000000 },
            {
              path: "node_modules/x.js",
              type: "blob",
              mode: "100644",
              size: 10,
            },
            { path: "link.py", type: "blob", mode: "120000", size: 10 },
          ],
        }),
      );
    if (String(url).includes("broken.py"))
      return new Response(null, { status: 404 });
    return new Response(
      String(url).endsWith("README.md") ? "# Example" : "print(1)",
    );
  });
  try {
    const result = await readTreeSources("BAITC-Hacks/test", sha);
    expect(result.files.map((f) => f.path)).toEqual([
      "README.md",
      "src/main.py",
    ]);
    expect(result.tree.filter((f) => f.reason)).toHaveLength(5);
    expect(mock.mock.calls.every(([url]) => String(url).includes(sha))).toBe(
      true,
    );
  } finally {
    mock.mockRestore();
  }
});

it("answers chat with immutable snapshot citations and rejects fabricated sources", async () => {
  const harness = await import("../server/harness.js");
  const { answerChat } = await import("../server/chat.js");
  const mock = vi.spyOn(harness, "oneShot").mockResolvedValue({
    text: JSON.stringify({
      answer: "В файле возвращается 42 [1].",
      citations: [
        {
          projectId: 2,
          path: "main.py",
          start: 2,
          end: 2,
          quote: "return 42",
        },
      ],
    }),
    model: "test-model",
    harness: "codex",
  });
  try {
    const reply = await answerChat(
      "Что делает проект?",
      [2],
      new AbortController().signal,
    );
    expect(reply.citations[0].url).toContain(
      `snapshot=${getProject(2)!.snapshotId}`,
    );
    expect(reply.citations[0].sha).toBe("a".repeat(40));
    mock.mockResolvedValue({
      text: JSON.stringify({
        answer: "Неподтверждённое утверждение",
        citations: [
          { projectId: 2, path: "missing.py", start: 1, end: 1, quote: "fake" },
        ],
      }),
      model: "test-model",
      harness: "codex",
    });
    await expect(
      answerChat("Что делает проект?", [2], new AbortController().signal),
    ).rejects.toThrow("Неверная ссылка");
  } finally {
    mock.mockRestore();
  }
});
it("does not call a model when chat has no loaded sources", async () => {
  const harness = await import("../server/harness.js");
  const { answerChat } = await import("../server/chat.js");
  const mock = vi.spyOn(harness, "oneShot");
  try {
    const reply = await answerChat(
      "Нет источников",
      [100],
      new AbortController().signal,
    );
    expect(reply.citations).toHaveLength(0);
    expect(mock).not.toHaveBeenCalled();
  } finally {
    mock.mockRestore();
  }
});

it("bulk launch queues missing work, prioritizes analysis, resumes and stays idempotent", async () => {
  // Reuse the imported fixture: 1 is empty, 2 has a snapshot, 3 needs sources.
  db.prepare("UPDATE projects SET status='empty' WHERE id=1").run();
  db.prepare("UPDATE analyses SET stale=1 WHERE project_id=2").run();
  db.prepare(
    "UPDATE jobs SET state='cancelled' WHERE project_id IN (1,2,3) AND state IN ('queued','running')",
  ).run();
  setSetting("paused", true);
  setSetting("pauseReason", "Пауза пользователя");
  const launch = () =>
    fetch(`${base}/api/jobs/analyze-all`, {
      method: "POST",
      headers: { "X-HackAlem": "local" },
    });
  const denied = await fetch(`${base}/api/jobs/analyze-all`, {
    method: "POST",
  });
  expect(denied.status).toBe(403);
  const first = await launch();
  expect(first.status).toBe(202);
  expect((await first.json()).added).toBeGreaterThanOrEqual(2);
  expect(setting("paused", true)).toBe(false);
  expect(setting("pauseReason", "missing")).toBe("");
  expect(
    db
      .prepare("SELECT id FROM jobs WHERE project_id=1 AND state='queued'")
      .get(),
  ).toBeUndefined();
  expect(
    db
      .prepare(
        "SELECT type,json_extract(payload,'$.priority') priority FROM jobs WHERE project_id=2 AND state='queued'",
      )
      .get(),
  ).toEqual({ type: "analyze", priority: -10 });
  expect(
    db
      .prepare("SELECT type FROM jobs WHERE project_id=3 AND state='queued'")
      .get(),
  ).toEqual({ type: "snapshot" });
  const repeated = await (await launch()).json();
  expect(repeated.added).toBe(0);
  expect(repeated.alreadyQueued).toBeGreaterThan(0);
  // Newly downloaded sources continue the same bulk run without waiting for all downloads.
  const next = enqueue("analyze", 3)!;
  expect(
    db
      .prepare(
        "SELECT json_extract(payload,'$.priority') priority FROM jobs WHERE id=?",
      )
      .get(next),
  ).toEqual({ priority: -10 });
  db.prepare(
    "UPDATE jobs SET state='done' WHERE project_id=2 AND type='analyze'",
  ).run();
  db.prepare(
    "UPDATE analyses SET stale=0 WHERE project_id=2 AND snapshot_id=(SELECT snapshot_id FROM projects WHERE id=2)",
  ).run();
  const completed = await (await launch()).json();
  expect(completed.completed).toBeGreaterThan(0);
  expect(
    db
      .prepare(
        "SELECT id FROM jobs WHERE project_id=2 AND type='analyze' AND state='queued'",
      )
      .get(),
  ).toBeUndefined();
});

it("aborting an archive in the middle of an entry rejects without crashing the worker", async () => {
  const response = await archive([
    { name: "large.txt", text: randomBytes(32000).toString("hex") },
  ]);
  const compressed = new Uint8Array(await response.arrayBuffer());
  const controller = new AbortController();
  const partial = new Response(
    new ReadableStream({
      start(stream) {
        stream.enqueue(compressed.slice(0, 1000));
      },
    }),
  );
  const timer = setTimeout(() => controller.abort(), 25);
  try {
    await expect(readArchive(partial, controller.signal)).rejects.toThrow();
  } finally {
    clearTimeout(timer);
  }
});

it("reads README, manifests and code before tests and data when chunking", () => {
  const file = (path: string) => ({ path, text: path, bytes: 1, lines: 1 });
  const order = (paths: string[]) =>
    sourceChunks(paths.map(file))
      .join("")
      .match(/FILE (\S+)/g)!
      .map((m) => m.slice(5));
  expect(
    order(["tests/a.py", "data/x.json", "docs/guide.md", "src/app.py", "package.json", "README.md"]),
  ).toEqual(["README.md", "package.json", "src/app.py", "docs/guide.md", "data/x.json", "tests/a.py"]);
});

it("corrects shifted line numbers for a verbatim quote but rejects invented text", () => {
  const file = { path: "README.md", text: "# T\n\nfirst\nsecond line here\nthird", bytes: 1, lines: 5 };
  const e = { path: "README.md", start: 2, end: 2, quote: "second line here" };
  validateEvidence([e], [file]);
  expect(e).toMatchObject({ start: 4, end: 4 });
  expect(() =>
    validateEvidence([{ path: "README.md", start: 2, end: 2, quote: "not in file" }], [file]),
  ).toThrow("Цитата не найдена");
});

it("hides and skips projects without a push inside the activity window", async () => {
  const { activeSql, isActive } = await import("../server/db.js");
  const recent = new Date(Date.now() - 3600000).toISOString();
  db.prepare("UPDATE projects SET pushed_at=? WHERE id=2").run(recent);
  db.prepare("UPDATE projects SET pushed_at='2020-01-01T00:00:00Z' WHERE id=3").run();
  try {
    setSetting("activityHours", 24);
    expect(isActive(2)).toBe(true);
    expect(isActive(3)).toBe(false);
    expect(listProjects().items.map((p) => p.id)).not.toContain(3);
    setSetting("activityHours", 0);
    expect(activeSql()).toBe("1");
    expect(isActive(3)).toBe(true);
  } finally {
    setSetting("activityHours", 0);
  }
});

it("shortlists per-track leaders before the overall best", async () => {
  const { buildShortlist } = await import("../server/catalog.js");
  const ids = (db.prepare("SELECT id FROM projects ORDER BY id LIMIT 4").all() as { id: number }[]).map((r) => r.id);
  const t = new Date().toISOString();
  db.prepare("UPDATE projects SET manual_track_id=NULL,track_id=NULL").run();
  const review = (id: number, track: number, total: number) => {
    const sid = Number(db.prepare("INSERT INTO readme_sources(project_id,sha,path,text,status,revision,created_at) VALUES(?,?,?,?,?,?,?)").run(id, "a".repeat(40), "README.md", "x".repeat(400), "ready", t, t).lastInsertRowid);
    db.prepare("INSERT INTO quick_reviews(project_id,source_id,track_id,total,data,created_at) VALUES(?,?,?,?,?,?)").run(id, sid, track, total, JSON.stringify({ trackId: track, candidates: [track] }), t);
  };
  // Track 1 has three strong projects; track 2 has one weak project that must still make the list.
  review(ids[0], 1, 95);
  review(ids[1], 1, 94);
  review(ids[2], 1, 93);
  review(ids[3], 2, 10);
  const picked = buildShortlist(2, 1);
  expect(picked).toContain(ids[0]);
  expect(picked).toContain(ids[3]);
  expect(picked).not.toContain(ids[2]);
});

it("recognizes the organization template README as having no description", async () => {
  const { isTemplateReadme } = await import("../server/quick.js");
  expect(isTemplateReadme("# hack-1-geeks\nHackathon team repository for Geeks\n")).toBe(true);
  expect(isTemplateReadme("# Хаттама\n\nИИ-секретарь совещаний: протокол с поручениями и сроками.")).toBe(false);
});

it("extracts the first JSON object when a model adds text around it", () => {
  expect(jsonAnswer('Вот ответ: {"a":"}{","b":[1]} спасибо')).toEqual({ a: "}{", b: [1] });
});

it("matches a quote that drops Markdown markup around spaces but not changed words", () => {
  const file = { path: "README.md", text: "# T\n`data/x.csv` — точная копия\n**Select** выбирает", bytes: 1, lines: 3 };
  const e = { path: "README.md", start: 2, end: 2, quote: "data/x.csv — точная копия" };
  validateEvidence([e], [file]);
  expect(e.quote).toBe("data/x.csv` — точная копия");
  expect(() =>
    validateEvidence([{ path: "README.md", start: 3, end: 3, quote: "Select выбрал" }], [file]),
  ).toThrow("Цитата не найдена");
});

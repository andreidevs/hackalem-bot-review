import { z } from "zod";
import { db, getProject, getSnapshot, latestAnalysis, setting } from "./db.js";
import { listProjects, rankings } from "./catalog.js";
import { tracks } from "./tracks.js";
import { oneShot, jsonAnswer } from "./harness.js";
import { SYSTEM, validateEvidence } from "./analysis.js";
export async function answerChat(
  question: string,
  ids: number[],
  signal: AbortSignal,
) {
  let projects = ids.map(getProject).filter((p) => p !== null);
  if (!projects.length && /лучш|лидер|рейтинг|топ/i.test(question)) {
    const track = tracks.find((t) =>
      question.toLowerCase().includes(t.name.toLowerCase().slice(0, 7)),
    );
    projects = rankings(track?.id).slice(0, 5);
  }
  if (!projects.length) {
    projects = listProjects({ q: question, limit: 5 }).items;
    if (!projects.length) {
      const words = question.match(/[\p{L}\p{N}]+/gu) || [];
      for (const word of words.filter((w) => w.length > 3).slice(0, 8)) {
        projects = listProjects({ q: word, limit: 5 }).items;
        if (projects.length) break;
      }
    }
  }
  const contexts = projects
    .map((p) => ({
      project: p,
      snapshot: p.snapshotId ? getSnapshot(p.snapshotId) : null,
      analysis: (() => {
        const a = latestAnalysis(p.id);
        return a && !a.stale && a.snapshotId === p.snapshotId ? a : null;
      })(),
    }))
    .filter((c) => c.snapshot);
  if (!contexts.length)
    return {
      answer:
        "В каталоге пока нет подходящих загруженных источников. Выберите проекты или уточните название, трек либо технологию.",
      citations: [],
    };
  const sourceData = contexts.map((c) => ({
    id: c.project.id,
    team: c.project.team,
    sha: c.snapshot!.sha,
    readme: c.snapshot!.readme.slice(0, 16000),
    analysis: c.analysis,
    files: c
      .snapshot!.files.filter((f) => /readme/i.test(f.path))
      .map((f) => ({
        path: f.path,
        text: f.text
          .slice(0, 18000)
          .split("\n")
          .map((s, i) => `${i + 1}: ${s}`)
          .join("\n"),
      })),
  }));
  const out = await oneShot({
    harness: setting("harness", "codex"),
    model: setting("model", ""),
    system: SYSTEM,
    prompt: `Ответь на вопрос только по переданным проектам. Если выборка не содержит все проекты, не называй лидера лучшим во всей организации. Укажи пределы выборки и непроверенные факты. Ссылайся [1], [2] на citations; нужны хотя бы 1 ссылка. Ответ не более 2500 символов. Формат {answer:string,citations:[{projectId:number,path:string,start:number,end:number,quote:string}]}.\nВопрос пользователя: ${JSON.stringify(question)}\nsourceData=${JSON.stringify(sourceData)}`,
    signal,
  });
  const value = z
    .object({
      answer: z.string().max(6000),
      citations: z
        .array(
          z.object({
            projectId: z.number(),
            path: z.string(),
            start: z.number().int().positive(),
            end: z.number().int().positive(),
            quote: z.string().min(1).transform((q) => q.slice(0, 1500)),
          }),
        )
        .min(1)
        .max(20),
    })
    .parse(jsonAnswer(out.text));
  const citations = value.citations.map((c) => {
    const context = contexts.find((p) => p.project.id === c.projectId);
    if (!context) throw new Error("Чат сослался на неизвестный проект");
    validateEvidence([c], context.snapshot!.files);
    return {
      ...c,
      snapshotId: context.snapshot!.id,
      sha: context.snapshot!.sha,
      url: `/project/${c.projectId}?file=${encodeURIComponent(c.path)}&snapshot=${context.snapshot!.id}&line=${c.start}`,
    };
  });
  return {
    answer: value.answer,
    citations,
    model: out.model,
    projectIds: contexts.map((c) => c.project.id),
  };
}

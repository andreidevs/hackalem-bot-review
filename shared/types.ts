export interface Criterion {
  id: string;
  title: string;
  max: number;
}
export interface Requirement {
  id: string;
  text: string;
  kind: "required" | "optional" | "constraint";
  sourceLine: number;
}
export interface Track {
  id: number;
  name: string;
  caseName: string;
  partner: string;
  documentId: string;
  url: string;
  spec: string;
  hash: string;
  requirements: Requirement[];
  rubric: Criterion[];
  rubricOrigin: "document" | "analytical";
  count?: number;
  analyzed?: number;
}
export interface Evidence {
  path: string;
  start: number;
  end: number;
  quote: string;
}
export type Verdict =
  | "code"
  | "readme"
  | "contradiction"
  | "runtime"
  | "unknown";
export interface Finding {
  requirementId: string;
  verdict: Verdict;
  explanation: string;
  evidence: Evidence[];
}
export interface Score {
  id: string;
  points: number;
  rationale: string;
  evidence: Evidence[];
}
export interface Analysis {
  id: number;
  projectId: number;
  snapshotId: number;
  trackId: number | null;
  candidates: number[];
  summary: string;
  architecture: string;
  aiUsage: string;
  reproducibility: string;
  technologies: string[];
  tags: string[];
  strengths: string[];
  weaknesses: string[];
  expertQuestions: string[];
  findings: Finding[];
  scores: Score[];
  commonScores: Score[];
  // HackAlem Demo Day jury scale (Положение, п. 5.7.2) without the presentation criterion.
  hackalemScores?: Score[];
  hackalemTotal?: number;
  total: number | null;
  commonTotal: number;
  model: string;
  harness: string;
  methodVersion: string;
  specHash: string;
  createdAt: string;
  stale: boolean;
  coverage: { read: number; skipped: number; chunks: number; omitted?: number };
}
export interface Project {
  id: number;
  name: string;
  fullName: string;
  team: string;
  description: string;
  url: string;
  branch: string;
  language: string | null;
  size: number;
  archived: boolean;
  trackId: number | null;
  manualTrackId: number | null;
  snapshotId: number | null;
  sha: string | null;
  summary: string;
  technologies: string[];
  tags: string[];
  status: string;
  error: string | null;
  updatedAt: string;
  pushedAt: string;
  // Default-branch commits: before 13:00, per hour 13–18 (Astana), after 18:00.
  commitStats: { before: number; window: number; after: number; hours: number[] } | null;
  readmeChecklist?: ReadmeChecklist | null;
  // Present in catalog lists: jury-scale score (of 80) and latest quick README score.
  hackalemTotal?: number | null;
  quickTotal?: number | null;
  syncedAt: string;
  total?: number | null;
  commonTotal?: number | null;
  rank?: number;
  analysisId?: number;
  stale?: boolean;
}
export interface SourceFile {
  path: string;
  text: string;
  bytes: number;
  lines: number;
}
export interface Snapshot {
  id: number;
  projectId: number;
  sha: string;
  readmePath: string | null;
  readme: string;
  tree: { path: string; bytes: number; reason?: string }[];
  files: SourceFile[];
  createdAt: string;
}
export interface Job {
  id: number;
  type: "sync" | "snapshot" | "analyze" | "chat" | "quick" | "final";
  projectId: number | null;
  state: "queued" | "running" | "done" | "failed" | "cancelled";
  payload: Record<string, unknown>;
  progress: string;
  attempts: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  result: unknown;
}
export interface HarnessInfo {
  id: "codex" | "claude";
  installed: boolean;
  ready: boolean;
  version: string;
  authMethod: string;
  note: string;
  model: string;
}
export interface QuickReview {
  id: number;
  readmeChecklist?: ReadmeChecklist | null;
  // Case named in the README itself, and whether the model chose a different one.
  declaredTrackId?: number | null;
  trackMismatch?: boolean;
  projectId: number;
  sourceId: number;
  team: string;
  sha: string;
  path: string | null;
  trackId: number | null;
  candidates: number[];
  summary: string;
  strengths: string[];
  risks: string[];
  scores: Score[];
  total: number;
  rank?: number;
  stale: boolean;
  model: string;
  methodVersion: string;
  createdAt: string;
  truncated: boolean;
  reviewedChars: number;
}
// Points are tied to checkable facts in the README, not to its length or polish.
export const QUICK_RUBRIC: Criterion[] = [
  { id: "problem", title: "Задача и пользователь", max: 10 },
  { id: "case", title: "Покрытие требований кейса", max: 25 },
  { id: "verifiable", title: "Проверяемость", max: 25 },
  { id: "value", title: "Польза и эффект", max: 20 },
  { id: "originality", title: "Отличие от аналогов", max: 20 },
];
export const VERDICTS: Record<Verdict, string> = {
  code: "Подтверждено кодом",
  readme: "Заявлено в README",
  contradiction: "Противоречие",
  runtime: "Требует запуска",
  unknown: "Недостаточно данных",
};
export const STATUS: Record<string, string> = {
  discovered: "Ожидает загрузки",
  ready: "Готов к анализу",
  empty: "Пустой репозиторий",
  no_readme: "Нет README",
  analyzing: "Анализируется",
  analyzed: "Оценён",
  unclassified: "Требует классификации",
  error: "Ошибка загрузки",
  stale: "Оценка устарела",
};

// Jury criteria of the HackAlem regulations (п. 5.7.2). "Презентация, демо и ответы" (20) happens
// on Demo Day and cannot be judged from the repository, so the static maximum is 80.
export const HACKALEM_RUBRIC: Criterion[] = [
  { id: "value", title: "Ценность решения", max: 25 },
  { id: "result", title: "Результат и качество решения", max: 20 },
  { id: "innovation", title: "Инновационность", max: 15 },
  { id: "potential", title: "Потенциал развития и масштабирования", max: 20 },
];
export const HACKALEM_MAX = 80;
// Mandatory README contents for the technical check (Положение, п. 5.4.15 / 5.6.4).
export const README_CHECKLIST: { id: string; title: string }[] = [
  { id: "description", title: "Описание решения и назначения" },
  { id: "architecture", title: "Архитектура" },
  { id: "technologies", title: "Используемые технологии" },
  { id: "install", title: "Инструкции по установке" },
  { id: "run", title: "Инструкции по запуску" },
  { id: "dependencies", title: "Необходимые зависимости" },
  { id: "env", title: "Параметры окружения" },
  { id: "verification", title: "Порядок проверки основного сценария" },
];
export type ReadmeChecklist = { passed: number; missing: string[] };
export const COMMON_RUBRIC: Criterion[] = [
  { id: "fit", title: "Соответствие задаче", max: 25 },
  { id: "technical", title: "Техническая реализация", max: 25 },
  { id: "reproducibility", title: "README и воспроизводимость", max: 25 },
  { id: "value", title: "Ценность и применимость", max: 15 },
  { id: "originality", title: "Потенциал и оригинальность", max: 10 },
];

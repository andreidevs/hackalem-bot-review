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
  total: number | null;
  commonTotal: number;
  model: string;
  harness: string;
  methodVersion: string;
  specHash: string;
  createdAt: string;
  stale: boolean;
  coverage: { read: number; skipped: number; chunks: number };
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
  type: "sync" | "snapshot" | "analyze" | "chat";
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

export const COMMON_RUBRIC: Criterion[] = [
  { id: "fit", title: "Соответствие задаче", max: 25 },
  { id: "technical", title: "Техническая реализация", max: 25 },
  { id: "reproducibility", title: "README и воспроизводимость", max: 25 },
  { id: "value", title: "Ценность и применимость", max: 15 },
  { id: "originality", title: "Потенциал и оригинальность", max: 10 },
];

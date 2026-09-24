import { createHash } from "node:crypto";
import specs from "../sources/specifications.json";
import type { Criterion, Track } from "../shared/types.js";
export const METHOD_VERSION = "2026-09-24.2";
import { COMMON_RUBRIC as commonRubric } from "../shared/types.js";
export { commonRubric };
const sanaRubric: Criterion[] = [
  { id: "flow", title: "Сквозной сценарий", max: 20 },
  { id: "card", title: "Качество карточки", max: 15 },
  { id: "gamification", title: "Геймификация бизнеса", max: 25 },
  { id: "catalog", title: "Каталог и отклики", max: 15 },
  { id: "ai", title: "AI-функция", max: 10 },
  { id: "technical", title: "Техническое качество", max: 10 },
  { id: "demo", title: "Демонстрация", max: 5 },
];
// The array indexes reference the user's twelve documents, not guesses from repository names.
const definitions: [number, string, string, string, number][] = [
  [1, "Энергетика", "Прогнозирование выработки ВЭС", "Самрук-Казына", 1],
  [2, "Финансы", "Граф денег", "Freedom", 2],
  [3, "Управление", "Halyk Career Quest", "Halyk Bank", 3],
  [4, "Телекоммуникации", "Тарифные кампании Beeline", "Beeline", 0],
  [5, "Логистика", "Заказы поставщикам", "Электрокомплект", 4],
  [6, "Креативные индустрии", "Умный подбор подрядчиков", "Firebird", 5],
  [7, "Образование", "AI Sana Challenge Hub", "МНВО — AI Sana", 6],
  [8, "Инновации", "Автопротоколирование совещаний", "Самрук-Казына", 7],
  [9, "Коммуникации", "Voice Router", "Halyk Bank", 8],
  [10, "Торговля", "Ассистент ekt.kz", "Электрокомплект", 9],
  [
    11,
    "Спецтрек Казахтелеком",
    "Анализ оргструктуры и функций",
    "Казахтелеком",
    10,
  ],
  [
    12,
    "Спецтрек Astana Innovations",
    "Аким на 5 часов",
    "Astana Innovations",
    11,
  ],
];
// Each checklist item is an actual excerpt and keeps its line in the frozen source.
function extractRequirements(text: string, track: number) {
  const lines = text.split(/\r?\n/);
  // These case tables have interleaved cells; preserve whole requirements and exceptions.
  const curated: Record<
    number,
    { required: number[]; optional: number[]; constraint: number[] }
  > = {
    1: {
      required: [12, 26, 27, 28, 29, 32, 38, 39, 40, 41],
      optional: [],
      constraint: [44],
    },
    3: {
      required: [67, 69, 71, 73, 75, 76],
      optional: [39, 77],
      constraint: [54, 62, 79, 81, 82, 83, 84, 85],
    },
    7: {
      required: [
        31, 34, 37, 40, 43, 46, 49, 52, 59, 61, 63, 65, 67, 69, 73, 101, 102,
        103, 104, 105, 107, 114, 118, 121, 124, 127, 185, 186, 187, 188, 190,
      ],
      optional: [134, 135, 136, 137, 138],
      constraint: [108, 109, 110, 111, 112],
    },
    9: {
      required: [52, 54, 56, 58, 60, 73],
      optional: [38, 63],
      constraint: [47, 65, 67, 68, 69, 70, 71, 74, 76, 77, 78],
    },
  };
  if (curated[track])
    return Object.entries(curated[track]).flatMap(([kind, positions]) =>
      positions.map((sourceLine) => ({
        id: `${track}-L${sourceLine}`,
        text: lines
          .slice(
            sourceLine - 1,
            track === 7 && [118, 121, 124, 127].includes(sourceLine)
              ? sourceLine + 2
              : sourceLine,
          )
          .map((l) => l.trim())
          .join(" — "),
        kind: kind as "required" | "optional" | "constraint",
        sourceLine,
      })),
    );
  let inRequired = false;
  let inOptional = false;
  let inConstraint = false;
  const result: Track["requirements"] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (
      /Must.have|Обязательный минимум|Обязательный функционал|Задача участников|^Задача$|^Критерии проверки/.test(
        line,
      )
    ) {
      inRequired = true;
      inOptional = false;
      inConstraint = false;
      continue;
    }
    if (/^(?:\d+[. ]+)?Опционально|^Дополнительно/.test(line)) {
      inRequired = false;
      inOptional = true;
      inConstraint = false;
    }
    if (
      /^(?:\d+[. ]+)?Ограничения|^6\. Жёсткие ограничения|^5 Использование искусственного/.test(
        line,
      )
    ) {
      inRequired = false;
      inOptional = false;
      inConstraint = true;
    }
    if (
      /^(?:\d+[. ]+)?Артефакты|^Критерий$|^9 Критерии оценки|^Данные$|^Не нужно|^4 Основная механика|^7 Ограничение/.test(
        line,
      )
    ) {
      inRequired = false;
      inOptional = false;
      inConstraint = false;
    }
    if (
      (inRequired || inOptional || inConstraint) &&
      line.length > 22 &&
      !/^\d+[. ]+(Must|Опционально|Ограничения)/.test(line)
    )
      result.push({
        id: `${track}-${result.length + 1}`,
        text: line,
        kind: inConstraint
          ? "constraint"
          : inOptional
            ? "optional"
            : "required",
        sourceLine: i + 1,
      });
  }
  return result;
}
export const tracks: Track[] = definitions.map(
  ([id, name, caseName, partner, index]) => {
    const d = specs[index];
    const spec = d.text.split(/\r?\n\s*KZ\s*\r?\n/)[0];
    return {
      id,
      name,
      caseName,
      partner,
      documentId: d.id,
      url: d.url,
      spec,
      hash: createHash("sha256").update(spec).digest("hex"),
      requirements: extractRequirements(spec, id),
      rubric: id === 7 ? sanaRubric : commonRubric,
      rubricOrigin: id === 5 || id === 10 ? "analytical" : "document",
    };
  },
);

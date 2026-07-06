import { categories, contextQuestion, questions, scoredQuestions } from "@/lib/scorecard-data";
import type {
  AnswerMap,
  CategoryId,
  CategoryScore,
  LeakResult,
  ScoreValue
} from "@/types/scorecard";

/**
 * Tie-break order when two categories score equally low: surface the one
 * closest to the money. Monetization and activation losses are the most
 * concrete for an operator; compounding is the most abstract.
 */
const LEAK_PRIORITY: CategoryId[] = [
  "monetization",
  "activation",
  "measurement",
  "acquisition",
  "compounding"
];

export const MAX_TOTAL_SCORE = scoredQuestions.length * 3;

export function getLeakStatus(score: ScoreValue) {
  if (score === 0) return "Severe leak";
  if (score === 1) return "Active leak";
  if (score === 2) return "Contained";
  return "Holding";
}

export function isComplete(answers: AnswerMap) {
  return questions.every((question) => typeof answers[question.id] === "number");
}

export function getCategoryScores(answers: AnswerMap): CategoryScore[] {
  return categories.map((category) => {
    const question = scoredQuestions.find((q) => q.category === category.id);
    const optionIndex = question ? answers[question.id] : undefined;
    const option =
      question && typeof optionIndex === "number" ? question.options[optionIndex] : undefined;
    const score = (option?.score ?? 0) as ScoreValue;

    return { category, score, status: getLeakStatus(score) };
  });
}

export function getLeakResult(answers: AnswerMap): LeakResult {
  const scores = getCategoryScores(answers);

  const leak = [...scores].sort(
    (a, b) =>
      a.score - b.score ||
      LEAK_PRIORITY.indexOf(a.category.id) - LEAK_PRIORITY.indexOf(b.category.id)
  )[0];

  const leakQuestion = scoredQuestions.find((q) => q.category === leak.category.id);
  const leakOptionIndex = leakQuestion ? answers[leakQuestion.id] : undefined;
  const echo =
    leakQuestion && typeof leakOptionIndex === "number"
      ? leakQuestion.options[leakOptionIndex]?.echo ?? ""
      : "";

  const revenueIndex = answers[contextQuestion.id];
  const revenueBand =
    typeof revenueIndex === "number"
      ? contextQuestion.options[revenueIndex]?.label ?? null
      : null;
  const revenueBandValue =
    typeof revenueIndex === "number"
      ? contextQuestion.options[revenueIndex]?.value ?? null
      : null;

  return {
    leak,
    scores,
    echo,
    revenueBand,
    revenueBandValue,
    totalScore: scores.reduce((total, entry) => total + entry.score, 0)
  };
}

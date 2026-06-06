import { categories, questions, resultBands } from "@/lib/scorecard-data";
import type {
  AnswerMap,
  CategoryConfig,
  CategoryScore,
  ResultBand,
  ScoreSummary
} from "@/types/scorecard";

const MAX_QUESTION_SCORE = 4;
const QUESTIONS_PER_CATEGORY = 3;
export const MAX_RAW_SCORE = questions.length * MAX_QUESTION_SCORE;
export const MAX_CATEGORY_SCORE = QUESTIONS_PER_CATEGORY * MAX_QUESTION_SCORE;

export function getLeakStatus(percentage: number) {
  if (percentage <= 39) return "Severe leak";
  if (percentage <= 59) return "Active leak";
  if (percentage <= 74) return "Moderate leak";
  if (percentage <= 89) return "Minor leak";
  return "Strong";
}

export function getResultBand(percentage: number): ResultBand {
  return (
    resultBands.find(
      (band) => percentage >= band.min && percentage <= band.max
    ) ?? resultBands[0]
  );
}

export function isComplete(answers: AnswerMap) {
  return questions.every((question) => typeof answers[question.id] === "number");
}

export function getRawScore(answers: AnswerMap) {
  return questions.reduce((total, question) => total + (answers[question.id] ?? 0), 0);
}

export function getScorePercentage(rawScore: number) {
  return Math.round((rawScore / MAX_RAW_SCORE) * 100);
}

export function getCategoryScores(answers: AnswerMap): CategoryScore[] {
  return categories.map((category: CategoryConfig) => {
    const categoryQuestions = questions.filter(
      (question) => question.category === category.id
    );
    const rawScore = categoryQuestions.reduce(
      (total, question) => total + (answers[question.id] ?? 0),
      0
    );
    const percentage = Math.round((rawScore / MAX_CATEGORY_SCORE) * 100);

    return {
      ...category,
      rawScore,
      percentage,
      status: getLeakStatus(percentage)
    };
  });
}

export function getScoreSummary(answers: AnswerMap): ScoreSummary {
  const rawScore = getRawScore(answers);
  const percentage = getScorePercentage(rawScore);
  const categoryScores = getCategoryScores(answers);
  const weakestCategories = [...categoryScores]
    .sort((a, b) => a.percentage - b.percentage || a.rawScore - b.rawScore)
    .slice(0, 2);

  return {
    rawScore,
    percentage,
    band: getResultBand(percentage),
    categoryScores,
    weakestCategories
  };
}

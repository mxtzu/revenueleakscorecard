export type CategoryId =
  | "acquisition"
  | "activation"
  | "monetisation"
  | "measurement"
  | "compounding";

export type AnswerValue = 0 | 1 | 2 | 3 | 4;

export type AnswerMap = Record<number, AnswerValue>;

export type AnswerOption = {
  value: AnswerValue;
  label: string;
};

export type ScorecardQuestion = {
  id: number;
  category: CategoryId;
  text: string;
  helpText: string;
};

export type CategoryConfig = {
  id: CategoryId;
  name: string;
  shortName: string;
  definition: string;
  diagnosis: string;
  recommendedAction: string;
};

export type ResultBand = {
  min: number;
  max: number;
  title: string;
  message: string;
  cta: string;
};

export type CategoryScore = CategoryConfig & {
  rawScore: number;
  percentage: number;
  status: string;
};

export type ScoreSummary = {
  rawScore: number;
  percentage: number;
  band: ResultBand;
  categoryScores: CategoryScore[];
  weakestCategories: CategoryScore[];
};

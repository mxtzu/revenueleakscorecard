export type CategoryId =
  | "acquisition"
  | "activation"
  | "monetization"
  | "measurement"
  | "compounding";

export type ScoreValue = 0 | 1 | 2 | 3;

export type ScoredOption = {
  score: ScoreValue;
  label: string;
  /** First-person restatement echoed back on the result screen as evidence. */
  echo: string;
};

export type ContextOption = {
  value: string;
  label: string;
};

export type ScoredQuestion = {
  kind: "scored";
  id: string;
  category: CategoryId;
  text: string;
  helpText: string;
  options: ScoredOption[];
};

export type ContextQuestion = {
  kind: "context";
  id: string;
  text: string;
  helpText: string;
  options: ContextOption[];
};

export type Question = ScoredQuestion | ContextQuestion;

/** questionId -> selected option index */
export type AnswerMap = Record<string, number>;

export type CategoryConfig = {
  id: CategoryId;
  name: string;
  /** One-line definition used on the landing category strip. */
  definition: string;
  leak: {
    /** Result-screen headline when this is the surfaced leak. */
    headline: string;
    /** Why it matters — causal, in the five-category language. Names the mechanism, never the fix. */
    mechanism: string;
  };
};

export type CategoryScore = {
  category: CategoryConfig;
  score: ScoreValue;
  status: string;
};

export type LeakResult = {
  /** The single surfaced leak — worst-scoring category. */
  leak: CategoryScore;
  /** All five categories in canonical order. */
  scores: CategoryScore[];
  /** Echo of the answer that drove the surfaced leak. */
  echo: string;
  /** Selected revenue band label, if answered. */
  revenueBand: string | null;
  /** Machine value of the revenue band, e.g. "25k_100k". */
  revenueBandValue: string | null;
  /** Sum of the five category scores, 0–15. */
  totalScore: number;
};

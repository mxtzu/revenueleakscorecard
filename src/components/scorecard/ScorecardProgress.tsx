import { Check } from "lucide-react";
import { categories, questions } from "@/lib/scorecard-data";
import type { AnswerMap } from "@/types/scorecard";

type ScorecardProgressProps = {
  currentStep: number;
  answers: AnswerMap;
};

export function ScorecardProgress({ currentStep, answers }: ScorecardProgressProps) {
  const answeredCount = questions.filter(
    (question) => typeof answers[question.id] === "number"
  ).length;
  const progressPercentage = Math.round((answeredCount / questions.length) * 100);
  const currentQuestion = questions[currentStep];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.22em] text-electric-400">
            Diagnostic progress
          </p>
          <p className="mt-1 text-sm text-slate-300">
            Question {currentStep + 1} of {questions.length}
          </p>
        </div>
        <p className="text-sm font-medium text-white">{progressPercentage}% complete</p>
      </div>

      <div className="h-2 overflow-hidden rounded-full bg-white/10" aria-hidden="true">
        <div
          className="h-full rounded-full bg-electric-400 transition-all duration-300"
          style={{ width: `${progressPercentage}%` }}
        />
      </div>

      <div className="grid gap-2 sm:grid-cols-5">
        {categories.map((category) => {
          const categoryQuestions = questions.filter(
            (question) => question.category === category.id
          );
          const answeredInCategory = categoryQuestions.filter(
            (question) => typeof answers[question.id] === "number"
          ).length;
          const isActive = currentQuestion.category === category.id;
          const isDone = answeredInCategory === categoryQuestions.length;

          return (
            <div
              key={category.id}
              className={`rounded-md border px-3 py-2 ${
                isActive
                  ? "border-electric-400 bg-electric-500/10 text-white"
                  : "border-white/10 bg-white/[0.03] text-slate-400"
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-xs font-medium">{category.shortName}</span>
                {isDone ? (
                  <Check className="h-3.5 w-3.5 text-emerald-300" aria-hidden="true" />
                ) : (
                  <span className="text-[0.68rem]">
                    {answeredInCategory}/{categoryQuestions.length}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

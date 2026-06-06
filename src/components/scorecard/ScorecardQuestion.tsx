"use client";

import { ArrowLeft, ArrowRight } from "lucide-react";
import { answerOptions, categories } from "@/lib/scorecard-data";
import type { AnswerValue, ScorecardQuestion as Question } from "@/types/scorecard";

type ScorecardQuestionProps = {
  question: Question;
  selectedAnswer?: AnswerValue;
  onAnswer: (value: AnswerValue) => void;
  onBack: () => void;
  onNext: () => void;
  isFirst: boolean;
  isLast: boolean;
};

export function ScorecardQuestion({
  question,
  selectedAnswer,
  onAnswer,
  onBack,
  onNext,
  isFirst,
  isLast
}: ScorecardQuestionProps) {
  const category = categories.find((item) => item.id === question.category);

  return (
    <section className="fade-in print-panel rounded-lg border border-white/10 bg-ink-850/95 p-5 shadow-blue-glow sm:p-7">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-[0.22em] text-electric-400">
            {category?.name}
          </p>
          <h2 className="mt-3 max-w-3xl text-2xl font-semibold leading-tight text-white sm:text-3xl">
            {question.text}
          </h2>
        </div>
        <div className="rounded-md border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-slate-300">
          Score 0-4
        </div>
      </div>

      <p className="mb-6 max-w-3xl text-base leading-7 text-slate-300">
        {question.helpText}
      </p>

      <div className="grid gap-3" role="radiogroup" aria-label={question.text}>
        {answerOptions.map((option) => {
          const isSelected = selectedAnswer === option.value;

          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={isSelected}
              onClick={() => onAnswer(option.value)}
              className={`group flex min-h-16 w-full items-center gap-4 rounded-md border px-4 py-3 text-left transition ${
                isSelected
                  ? "border-electric-400 bg-electric-500/12 text-white"
                  : "border-white/10 bg-white/[0.03] text-slate-300 hover:border-white/25 hover:bg-white/[0.06]"
              }`}
            >
              <span
                className={`grid h-9 w-9 shrink-0 place-items-center rounded-md border text-sm font-semibold ${
                  isSelected
                    ? "border-electric-400 bg-electric-500 text-white"
                    : "border-white/15 bg-ink-900 text-slate-300"
                }`}
              >
                {option.value}
              </span>
              <span className="text-sm font-medium sm:text-base">{option.label}</span>
            </button>
          );
        })}
      </div>

      <div className="mt-7 flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={onBack}
          disabled={isFirst}
          className="no-print inline-flex min-h-11 items-center gap-2 rounded-md border border-white/10 px-4 py-2 text-sm font-medium text-slate-200 transition hover:border-white/25 hover:bg-white/[0.05] disabled:cursor-not-allowed disabled:opacity-40"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Back
        </button>

        <button
          type="button"
          onClick={onNext}
          disabled={typeof selectedAnswer !== "number"}
          className="no-print inline-flex min-h-11 items-center gap-2 rounded-md bg-electric-500 px-5 py-2 text-sm font-semibold text-ink-950 transition hover:bg-electric-400 disabled:cursor-not-allowed disabled:opacity-45"
        >
          {isLast ? "Unlock results" : "Next"}
          <ArrowRight className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    </section>
  );
}

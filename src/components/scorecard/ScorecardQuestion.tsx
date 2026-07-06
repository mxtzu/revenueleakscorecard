"use client";

import clsx from "clsx";
import { categories } from "@/lib/scorecard-data";
import type { Question } from "@/types/scorecard";

type ScorecardQuestionProps = {
  question: Question;
  step: number;
  totalSteps: number;
  selectedIndex: number | undefined;
  onSelect: (optionIndex: number) => void;
  onBack: () => void;
  isFirst: boolean;
};

function getEyebrow(question: Question) {
  if (question.kind === "context") return "Baseline";
  return categories.find((category) => category.id === question.category)?.name ?? "";
}

export function ScorecardQuestion({
  question,
  step,
  totalSteps,
  selectedIndex,
  onSelect,
  onBack,
  isFirst
}: ScorecardQuestionProps) {
  const progress = Math.round(((step + 1) / totalSteps) * 100);

  return (
    <main className="fade-in mx-auto max-w-2xl pb-16 pt-10 sm:pt-16" key={question.id}>
      <div className="flex items-center justify-between gap-4">
        <p className="label-mono text-slate-500">
          Question {String(step + 1).padStart(2, "0")} / {String(totalSteps).padStart(2, "0")}
        </p>
        <p className="label-mono text-electric-400">{getEyebrow(question)}</p>
      </div>
      <div className="mt-3 h-px w-full bg-white/10">
        <div
          className="h-px bg-electric-500 transition-all duration-300"
          style={{ width: `${progress}%` }}
        />
      </div>

      <h2 className="mt-8 text-xl font-semibold leading-8 text-white sm:text-2xl sm:leading-9">
        {question.text}
      </h2>
      <p className="mt-3 text-sm leading-6 text-slate-500">{question.helpText}</p>

      <div className="mt-7 space-y-3">
        {question.options.map((option, index) => {
          const selected = selectedIndex === index;

          return (
            <button
              key={option.label}
              type="button"
              onClick={() => onSelect(index)}
              aria-pressed={selected}
              className={clsx(
                "block w-full rounded-md border px-5 py-4 text-left text-sm leading-6 transition sm:text-base",
                selected
                  ? "border-electric-500 bg-electric-500/10 text-white"
                  : "border-line bg-ink-900 text-slate-300 hover:border-slate-500 hover:text-white"
              )}
            >
              {option.label}
            </button>
          );
        })}
      </div>

      {!isFirst ? (
        <button
          type="button"
          onClick={onBack}
          className="label-mono mt-8 text-slate-500 transition hover:text-white"
        >
          ← Back
        </button>
      ) : null}
    </main>
  );
}

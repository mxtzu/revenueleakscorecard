"use client";

import { CategoryNameLabel } from "@/components/scorecard/CategoryNameLabel";
import { categories } from "@/lib/scorecard-data";

type ScorecardLandingProps = {
  onStart: () => void;
};

export function ScorecardLanding({ onStart }: ScorecardLandingProps) {
  return (
    <main className="fade-in pb-16">
      <section className="pt-12 sm:pt-20">
        <CategoryNameLabel withQualifier />
        <h1 className="display mt-5 max-w-3xl text-4xl text-white sm:text-6xl">
          Your Revenue Leak Has a Name. Find It in Two Minutes.
        </h1>
        <p className="mt-6 max-w-2xl text-base leading-7 text-slate-300 sm:text-lg sm:leading-8">
          Six questions, answerable straight from your Creator Dashboard. The scorecard
          maps your funnel across the five places post-traction Roblox games lose money —
          and names the leak costing you the most.
        </p>
        <div className="mt-8">
          <button
            type="button"
            onClick={onStart}
            className="inline-flex min-h-12 w-full items-center justify-center rounded-md bg-electric-500 px-8 text-base font-semibold text-white transition hover:bg-electric-400 sm:w-auto"
          >
            Run the Scorecard
          </button>
          <p className="label-mono mt-4 text-slate-500">
            6 Questions · ~2 Min · No Numbers You Don&apos;t Already Have
          </p>
        </div>
      </section>

      <div className="hairline mt-14" />

      <section className="mt-10">
        <p className="label-mono text-slate-500">The Five Leak Categories</p>
        <ul className="mt-6">
          {categories.map((category, index) => (
            <li key={category.id}>
              {index > 0 ? <div className="hairline" /> : null}
              <div className="flex items-baseline gap-4 py-4 sm:gap-6">
                <span className="label-mono w-7 shrink-0 text-electric-400">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span className="w-32 shrink-0 font-semibold text-white sm:w-40">
                  {category.name}
                </span>
                <span className="text-sm leading-6 text-slate-400">
                  {category.definition}
                </span>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <div className="hairline mt-6" />

      <p className="mt-8 max-w-2xl text-sm leading-6 text-slate-500">
        Built for post-traction studios with meaningful monthly revenue — operators who
        have shipped, monetized, and hit a ceiling. Not a launch-week checklist.
      </p>
    </main>
  );
}

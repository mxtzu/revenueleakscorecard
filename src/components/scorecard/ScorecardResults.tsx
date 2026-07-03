"use client";

import { AuditCTA } from "@/components/scorecard/AuditCTA";
import { CategoryNameLabel } from "@/components/scorecard/CategoryNameLabel";
import { FragmentedHireSection } from "@/components/scorecard/FragmentedHireSection";
import { LeakMap } from "@/components/scorecard/LeakMap";
import { ProofModule } from "@/components/scorecard/ProofModule";
import type { LeakResult } from "@/types/scorecard";

type ScorecardResultsProps = {
  result: LeakResult;
  onRestart: () => void;
};

/**
 * Result screen, top to bottom per the rebuild spec:
 * category eyebrow → leak headline → evidence + why it matters →
 * leak map → fragmented-hire argument → proof → audit CTA.
 * Names the mechanism and the evidence; never the fix.
 */
function getRevenueLine(result: LeakResult) {
  if (!result.revenueBand) return null;

  const band = result.revenueBand.replace("Under", "under");
  return result.revenueBandValue === "under_5k"
    ? ` At ${band} a month, sealing this before scaling is the whole game.`
    : ` At ${band} a month, that is not a rounding error.`;
}

export function ScorecardResults({ result, onRestart }: ScorecardResultsProps) {
  const { leak } = result;
  const revenueLine = getRevenueLine(result);

  return (
    <main className="fade-in space-y-6 pb-16 pt-10 sm:space-y-8 sm:pt-16">
      <section>
        <CategoryNameLabel />
        <h1 className="display mt-4 max-w-4xl text-3xl text-white sm:text-5xl">
          {leak.category.leak.headline}
        </h1>
      </section>

      <section className="rounded-lg border border-line bg-ink-900 p-6 shadow-card sm:p-8">
        <p className="label-mono text-slate-500">What You Told Us</p>
        <p className="mt-3 text-base font-semibold leading-7 text-white sm:text-lg">
          {result.echo ? `On ${leak.category.name.toLowerCase()}: ${result.echo}.` : ""}
          {revenueLine ? <span className="text-slate-400">{revenueLine}</span> : null}
        </p>

        <div className="hairline my-6" />

        <p className="label-mono text-slate-500">Why It Matters</p>
        <p className="mt-3 max-w-3xl text-sm leading-7 text-slate-300 sm:text-base sm:leading-8">
          {leak.category.leak.mechanism}
        </p>
      </section>

      <LeakMap scores={result.scores} leakId={leak.category.id} />

      <FragmentedHireSection />

      <ProofModule />

      <AuditCTA result={result} />

      <div className="flex flex-col items-start justify-between gap-4 pt-2 sm:flex-row sm:items-center">
        <p className="text-sm leading-6 text-slate-500">
          This scorecard is a diagnostic starting point, not a guarantee of results.
        </p>
        <button
          type="button"
          onClick={onRestart}
          className="label-mono text-slate-500 transition hover:text-white"
        >
          Restart Scorecard
        </button>
      </div>
    </main>
  );
}

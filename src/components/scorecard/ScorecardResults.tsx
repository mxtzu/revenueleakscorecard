"use client";

import { Download, RefreshCcw } from "lucide-react";
import { CategoryBreakdown } from "@/components/scorecard/CategoryBreakdown";
import { CTASection } from "@/components/scorecard/CTASection";
import { ScoreBadge } from "@/components/scorecard/ScoreBadge";
import { getScoreEventPayload, trackScorecardEvent } from "@/lib/tracking";
import type { ScoreSummary } from "@/types/scorecard";

type ScorecardResultsProps = {
  summary: ScoreSummary;
  email?: string;
  onRestart: () => void;
};

export function ScorecardResults({ summary, email, onRestart }: ScorecardResultsProps) {
  const weakestIds = summary.weakestCategories.map((category) => category.id);

  function handlePrint() {
    trackScorecardEvent("summary_print_clicked", getScoreEventPayload(summary));
    window.print();
  }

  return (
    <main className="fade-in space-y-8 py-8 sm:py-10">
      <section className="print-panel rounded-lg border border-white/10 bg-ink-850 p-6 shadow-blue-glow sm:p-8">
        <div className="grid gap-8 lg:grid-cols-[auto_1fr] lg:items-center">
          <ScoreBadge percentage={summary.percentage} />

          <div>
            <div className="mb-3 flex flex-wrap items-center gap-3">
              <p className="text-xs uppercase tracking-[0.22em] text-electric-400">
                Roblox Revenue Leak Scorecard
              </p>
              <span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-xs font-medium text-slate-300">
                {summary.rawScore}/60 raw score
              </span>
            </div>
            <h1 className="max-w-4xl text-3xl font-semibold leading-tight text-white sm:text-5xl">
              {summary.band.title}
            </h1>
            <p className="mt-5 max-w-4xl text-base leading-7 text-slate-300 print-muted sm:text-lg sm:leading-8">
              {summary.band.message}
            </p>

            <div className="no-print mt-6 flex flex-col gap-3 sm:flex-row">
              <button
                type="button"
                onClick={handlePrint}
                className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-white/12 px-4 py-2 text-sm font-semibold text-white transition hover:border-white/25 hover:bg-white/[0.05]"
              >
                <Download className="h-4 w-4" aria-hidden="true" />
                Print summary
              </button>
              <button
                type="button"
                onClick={onRestart}
                className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-white/12 px-4 py-2 text-sm font-semibold text-white transition hover:border-white/25 hover:bg-white/[0.05]"
              >
                <RefreshCcw className="h-4 w-4" aria-hidden="true" />
                Restart
              </button>
            </div>
          </div>
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-[0.9fr_1.1fr]">
        <div className="print-panel rounded-lg border border-white/10 bg-ink-850 p-5">
          <p className="text-xs uppercase tracking-[0.22em] text-electric-400">
            Top 2 weakest categories
          </p>
          <div className="mt-5 space-y-4">
            {summary.weakestCategories.map((category, index) => (
              <div
                key={category.id}
                className="rounded-md border border-white/10 bg-white/[0.035] p-4"
              >
                <div className="flex items-center justify-between gap-4">
                  <p className="font-semibold text-white">
                    {index + 1}. {category.name}
                  </p>
                  <span className="text-sm font-semibold text-electric-300">
                    {category.percentage}%
                  </span>
                </div>
                <p className="mt-2 text-sm leading-6 text-slate-400 print-muted">
                  {category.recommendedAction}
                </p>
              </div>
            ))}
          </div>
        </div>

        <div className="print-panel rounded-lg border border-white/10 bg-ink-850 p-5">
          <p className="text-xs uppercase tracking-[0.22em] text-electric-400">
            What this means
          </p>
          <h2 className="mt-3 text-2xl font-semibold text-white">
            Your next growth constraint is probably not another isolated tactic.
          </h2>
          <p className="mt-4 text-sm leading-7 text-slate-300 print-muted">
            Treat the lowest categories as lifecycle leaks that are limiting player
            value. If source quality, first-purchase path, retention-safe monetisation,
            and experiment discipline are not connected, more traffic can make the
            same revenue problem louder instead of more profitable.
          </p>
          <div className="mt-5 rounded-md border border-electric-400/25 bg-electric-500/10 p-4">
            <p className="text-sm font-semibold text-white">Recommended next move</p>
            <p className="mt-2 text-sm leading-6 text-slate-300 print-muted">
              Run a Revenue Leak Audit around {summary.weakestCategories[0].shortName.toLowerCase()}{" "}
              and {summary.weakestCategories[1].shortName.toLowerCase()}, then turn the
              findings into a 30/60/90 roadmap for what to fix first.
            </p>
          </div>
        </div>
      </section>

      <section>
        <div className="mb-5">
          <p className="text-xs uppercase tracking-[0.22em] text-electric-400">
            Category breakdown
          </p>
          <h2 className="mt-3 text-3xl font-semibold text-white">
            Lifecycle leak analysis
          </h2>
        </div>
        <CategoryBreakdown
          categories={summary.categoryScores}
          weakestIds={weakestIds}
        />
      </section>

      <CTASection email={email} summary={summary} />

      <p className="pb-8 text-center text-sm text-slate-500 print-muted">
        This scorecard is a diagnostic starting point, not a guarantee of results.
      </p>
    </main>
  );
}

"use client";

import { ArrowRight, Gauge, LineChart, ShieldCheck } from "lucide-react";
import { REVENUE_LEAK_APPLICATION_URL } from "@/lib/links";
import { trackScorecardEvent } from "@/lib/tracking";

type ScorecardLandingProps = {
  onStart: () => void;
};

export function ScorecardLanding({ onStart }: ScorecardLandingProps) {
  return (
    <section className="grid min-h-[calc(100vh-48px)] items-center gap-8 py-8 lg:grid-cols-[1.04fr_0.96fr] lg:py-12">
      <div className="max-w-3xl">
        <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-electric-400/30 bg-electric-500/10 px-3 py-1 text-xs font-medium uppercase tracking-[0.18em] text-electric-400">
          <Gauge className="h-3.5 w-3.5" aria-hidden="true" />
          ASCEND diagnostic
        </div>

        <h1 className="text-4xl font-semibold leading-[1.05] text-white sm:text-6xl lg:text-7xl">
          Roblox Revenue Leak Scorecard
        </h1>
        <p className="mt-6 max-w-2xl text-lg leading-8 text-slate-300">
          Find where traffic without value capture is suppressing player value:
          acquisition quality, first-session clarity, payer conversion, measurement,
          and the growth work that should compound after every update.
        </p>

        <div className="mt-8 flex flex-col gap-3 sm:flex-row">
          <button
            type="button"
            onClick={onStart}
            className="inline-flex min-h-12 items-center justify-center gap-2 rounded-md bg-electric-500 px-5 py-3 text-sm font-semibold text-ink-950 transition hover:bg-electric-400"
          >
            Start the scorecard
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </button>
          <a
            href={REVENUE_LEAK_APPLICATION_URL}
            onClick={() =>
              trackScorecardEvent("audit_cta_clicked", {
                location: "landing",
                destination: REVENUE_LEAK_APPLICATION_URL
              })
            }
            className="inline-flex min-h-12 items-center justify-center rounded-md border border-white/12 px-5 py-3 text-sm font-semibold text-white transition hover:border-white/25 hover:bg-white/[0.05]"
          >
            Book a Revenue Leak Audit
          </a>
        </div>

        <div className="mt-8 grid gap-3 text-sm text-slate-300 sm:grid-cols-3">
          <div className="rounded-md border border-white/10 bg-white/[0.035] p-4">
            <LineChart className="mb-3 h-5 w-5 text-electric-400" aria-hidden="true" />
            D1/D7/D30, payer conversion, ARPPU, ARPDAU, payback.
          </div>
          <div className="rounded-md border border-white/10 bg-white/[0.035] p-4">
            <ShieldCheck className="mb-3 h-5 w-5 text-emerald-300" aria-hidden="true" />
            Retention-safe monetisation and first-purchase path clarity.
          </div>
          <div className="rounded-md border border-white/10 bg-white/[0.035] p-4">
            <Gauge className="mb-3 h-5 w-5 text-amber-300" aria-hidden="true" />
            A diagnosis-first read on what to fix first.
          </div>
        </div>
      </div>

      <div className="print-panel rounded-lg border border-white/10 bg-ink-850/90 p-5 shadow-blue-glow sm:p-6">
        <div className="mb-5 flex items-center justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-electric-400">
              Lifecycle leak map
            </p>
            <h2 className="mt-2 text-xl font-semibold text-white">Player value system</h2>
          </div>
          <div className="rounded-md border border-white/10 px-3 py-2 text-sm text-slate-300">
            15 signals
          </div>
        </div>

        <div className="space-y-3">
          {[
            ["Acquisition", "Source quality before spend"],
            ["Activation", "First 60 seconds and first-session clarity"],
            ["Monetisation", "First purchase, offer ladder, pricing"],
            ["Measurement", "KPI tree and experiment discipline"],
            ["Compounding", "Shared 30/60/90 revenue roadmap"]
          ].map(([label, detail], index) => (
            <div
              key={label}
              className="grid grid-cols-[40px_1fr] gap-3 rounded-md border border-white/10 bg-white/[0.035] p-4"
            >
              <div className="grid h-10 w-10 place-items-center rounded-md border border-electric-400/35 bg-electric-500/10 text-sm font-semibold text-electric-400">
                {index + 1}
              </div>
              <div>
                <p className="font-semibold text-white">{label}</p>
                <p className="mt-1 text-sm leading-6 text-slate-400">{detail}</p>
              </div>
            </div>
          ))}
        </div>

        <p className="mt-5 border-t border-white/10 pt-5 text-sm leading-6 text-slate-300">
          Built for live Roblox studios with real traffic, real revenue, active updates,
          and budget to reinvest.
        </p>
      </div>
    </section>
  );
}

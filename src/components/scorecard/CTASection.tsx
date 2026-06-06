"use client";

import { ArrowRight, CalendarCheck, FileText } from "lucide-react";
import { getScoreEventPayload, trackScorecardEvent } from "@/lib/tracking";
import type { ScoreSummary } from "@/types/scorecard";

type CTASectionProps = {
  email?: string;
  summary: ScoreSummary;
};

export function CTASection({ email, summary }: CTASectionProps) {
  function handleAuditClick() {
    trackScorecardEvent("audit_cta_clicked", {
      ...getScoreEventPayload(summary),
      hasEmail: Boolean(email),
      location: "results",
      destination: "https://t.co/Zc46iJTUX9"
    });
    window.location.href = "https://t.co/Zc46iJTUX9";
  }

  function handleRoadmapClick() {
    // TODO: Connect this secondary CTA to a lead magnet, CRM sequence, or download endpoint.
    trackScorecardEvent("roadmap_cta_clicked", {
      ...getScoreEventPayload(summary),
      hasEmail: Boolean(email),
      location: "results"
    });
    const subject = encodeURIComponent("30/60/90 Revenue Roadmap request");
    window.location.href = `mailto:hello@ascendops.com?subject=${subject}`;
  }

  return (
    <section
      id="audit"
      className="print-panel rounded-lg border border-electric-400/30 bg-electric-500/10 p-6 shadow-blue-glow sm:p-8"
    >
      <div className="grid gap-6 lg:grid-cols-[1fr_auto] lg:items-center">
        <div>
          <p className="text-xs uppercase tracking-[0.22em] text-electric-300">
            ASCEND Revenue Leak Audit
          </p>
          <h2 className="mt-3 max-w-3xl text-3xl font-semibold leading-tight text-white">
            Know your score. Now find the leak costing you the most revenue.
          </h2>
          <p className="mt-4 max-w-4xl text-base leading-7 text-slate-300">
            The scorecard gives you the surface diagnosis. The Revenue Leak Audit maps
            the lifecycle properly: acquisition quality, first-session clarity, payer
            conversion, offer ladder, analytics, and the 30/60/90 roadmap for what to
            fix first.
          </p>
          <p className="mt-4 text-sm font-medium text-slate-200">
            Built for live Roblox studios with real traffic, real revenue, and budget
            to reinvest.
          </p>
        </div>

        <div className="no-print flex flex-col gap-3 sm:flex-row lg:flex-col">
          <button
            type="button"
            onClick={handleAuditClick}
            className="inline-flex min-h-12 items-center justify-center gap-2 rounded-md bg-electric-500 px-5 py-3 text-sm font-semibold text-ink-950 transition hover:bg-electric-400"
          >
            <CalendarCheck className="h-4 w-4" aria-hidden="true" />
            Book a Revenue Leak Audit
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={handleRoadmapClick}
            className="inline-flex min-h-12 items-center justify-center gap-2 rounded-md border border-white/12 px-5 py-3 text-sm font-semibold text-white transition hover:border-white/25 hover:bg-white/[0.05]"
          >
            <FileText className="h-4 w-4" aria-hidden="true" />
            Get the 30/60/90 Revenue Roadmap
          </button>
        </div>
      </div>
    </section>
  );
}

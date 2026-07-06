"use client";

import { CategoryNameLabel } from "@/components/scorecard/CategoryNameLabel";
import { getAuditUrl } from "@/lib/links";
import { getTrackingContext, trackScorecardEvent } from "@/lib/tracking";
import type { LeakResult } from "@/types/scorecard";

type AuditCTAProps = {
  result: LeakResult;
};

/**
 * The primary paid action. Carries the session + leak category into the
 * application URL so the scorecard→audit stage joins up in reporting.
 */
export function AuditCTA({ result }: AuditCTAProps) {
  function handleClick() {
    trackScorecardEvent("audit_cta_clicked", {
      leakCategory: result.leak.category.id,
      totalScore: result.totalScore
    });
  }

  const href = getAuditUrl(getTrackingContext(), result.leak.category.id);

  return (
    <section className="rounded-lg border border-electric-500/40 bg-ink-900 p-6 shadow-glow sm:p-8">
      <CategoryNameLabel />
      <h2 className="display mt-4 max-w-3xl text-2xl text-white sm:text-3xl">
        The Scorecard Names the Leak. The Audit Prices It — and Sequences the Fix.
      </h2>
      <p className="mt-5 max-w-2xl text-sm leading-7 text-slate-300 sm:text-base sm:leading-8">
        The Revenue Leak Audit is the paid, full-funnel diagnosis behind this scorecard:
        what your {result.leak.category.name.toLowerCase()} leak is costing each month,
        which fix moves revenue first, and the order to run the fixes in without breaking
        retention.
      </p>
      <div className="mt-7">
        <a
          href={href}
          onClick={handleClick}
          className="inline-flex min-h-12 w-full items-center justify-center rounded-md bg-electric-500 px-8 text-base font-semibold text-white transition hover:bg-electric-400 sm:w-auto"
        >
          Book the Revenue Leak Audit
        </a>
        <p className="label-mono mt-4 text-slate-500">Paid Diagnostic · Application Required</p>
      </div>
    </section>
  );
}

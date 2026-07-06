import { proofConfig } from "@/lib/proofConfig";

/**
 * Proof element above the audit CTA (P1 fix #3). Renders entirely from
 * proofConfig — flipping `verified` and filling `stat` upgrades this from
 * credibility strip to stat card with zero component changes. An unverified
 * stat is never rendered.
 */
export function ProofModule() {
  const showStat = proofConfig.verified && proofConfig.stat;

  return (
    <section className="rounded-lg border border-line bg-ink-900 p-6 shadow-card sm:p-8">
      <div className="flex items-center gap-3">
        <span className="label-mono text-electric-400">Proof</span>
        <span className="hairline flex-1" aria-hidden="true" />
        <span className="label-mono text-slate-500">
          {proofConfig.verified ? "Verified Result" : "From a Live Engagement"}
        </span>
      </div>

      {showStat ? (
        <div className="mt-6 flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="display text-5xl text-white sm:text-6xl">{proofConfig.stat}</p>
            {proofConfig.statLabel ? (
              <p className="label-mono mt-3 text-slate-400">{proofConfig.statLabel}</p>
            ) : null}
          </div>
          <div className="max-w-md">
            <p className="text-sm leading-6 text-slate-300">{proofConfig.claim}</p>
            <p className="label-mono mt-3 text-slate-500">{proofConfig.source}</p>
          </div>
        </div>
      ) : (
        <div className="mt-5">
          <p className="text-lg font-semibold leading-7 text-white sm:text-xl sm:leading-8">
            {proofConfig.claim}
          </p>
          <p className="label-mono mt-4 text-slate-500">{proofConfig.source}</p>
        </div>
      )}
    </section>
  );
}

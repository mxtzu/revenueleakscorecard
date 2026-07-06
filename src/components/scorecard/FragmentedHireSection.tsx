import { CATEGORY_NAME } from "@/lib/brand";

/**
 * The fragmented-hire argument (P1 fix #2). Sits after the scoring
 * mechanism, before the proof module and audit CTA. Argues the seams,
 * names no competitors, prescribes no fix.
 */
export function FragmentedHireSection() {
  return (
    <section className="rounded-lg border border-line bg-ink-900 p-6 shadow-card sm:p-8">
      <p className="label-mono text-electric-400">Why the Usual Fix Fails</p>
      <h2 className="display mt-4 text-2xl text-white sm:text-3xl">
        Three Specialists Can&apos;t Fix One Compounding Leak
      </h2>
      <p className="mt-5 max-w-3xl text-sm leading-7 text-slate-300 sm:text-base sm:leading-8">
        The standard move is to hire for the symptom: a UA specialist for traffic, a
        monetization consultant for the store, a data analyst for the dashboards. Each one
        optimizes their slice — and each slice can genuinely improve while total revenue
        stays flat. Leaks compound across categories: scale acquisition on top of a
        monetization leak and you are paying to run the loss faster. Point solutions
        don&apos;t fail at their jobs. They fail between them, in the seams nobody was
        hired to own.
      </p>
      <div className="mt-6 border-l-2 border-electric-500 bg-electric-500/[0.07] px-5 py-4">
        <p className="text-sm font-semibold leading-6 text-white sm:text-base">
          A {CATEGORY_NAME} reads the whole system at once — because the seams are where
          the money goes.
        </p>
      </div>
    </section>
  );
}

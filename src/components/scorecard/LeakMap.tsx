import clsx from "clsx";
import type { CategoryScore } from "@/types/scorecard";

type LeakMapProps = {
  scores: CategoryScore[];
  leakId: string;
};

/**
 * The scoring mechanism readout: all five categories, three-segment bars,
 * worst one highlighted. Evidence only — no per-category advice here; the
 * fix lives behind the audit.
 */
export function LeakMap({ scores, leakId }: LeakMapProps) {
  return (
    <section className="rounded-lg border border-line bg-ink-900 p-6 shadow-card sm:p-8">
      <p className="label-mono text-slate-500">Leak Map · All Five Categories</p>
      <ul className="mt-6">
        {scores.map((entry, index) => {
          const isLeak = entry.category.id === leakId;

          return (
            <li key={entry.category.id}>
              {index > 0 ? <div className="hairline" /> : null}
              <div className="flex items-center gap-4 py-4 sm:gap-6">
                <span
                  className={clsx(
                    "w-32 shrink-0 text-sm font-semibold sm:w-40 sm:text-base",
                    isLeak ? "text-electric-400" : "text-white"
                  )}
                >
                  {entry.category.name}
                </span>
                <div className="flex flex-1 gap-1" aria-hidden="true">
                  {[0, 1, 2].map((segment) => (
                    <span
                      key={segment}
                      className={clsx(
                        "h-1 flex-1 rounded-full",
                        segment < entry.score
                          ? isLeak
                            ? "bg-electric-500"
                            : "bg-slate-500"
                          : "bg-white/10"
                      )}
                    />
                  ))}
                </div>
                <span
                  className={clsx(
                    "label-mono w-24 shrink-0 text-right sm:w-28",
                    isLeak ? "text-electric-400" : "text-slate-500"
                  )}
                >
                  {entry.status}
                </span>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

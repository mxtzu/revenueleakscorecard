import clsx from "clsx";
import { AlertTriangle, CheckCircle2, Gauge } from "lucide-react";
import type { CategoryScore } from "@/types/scorecard";
import { ScoreBadge } from "@/components/scorecard/ScoreBadge";

type CategoryBreakdownProps = {
  categories: CategoryScore[];
  weakestIds: string[];
};

function statusStyle(status: string) {
  if (status === "Severe leak") return "border-rose-400/35 bg-rose-500/10 text-rose-200";
  if (status === "Active leak") return "border-orange-300/35 bg-orange-400/10 text-orange-100";
  if (status === "Moderate leak") return "border-amber-300/35 bg-amber-300/10 text-amber-100";
  if (status === "Minor leak") return "border-emerald-300/35 bg-emerald-300/10 text-emerald-100";
  return "border-electric-400/35 bg-electric-500/10 text-electric-200";
}

function StatusIcon({ status }: { status: string }) {
  if (status === "Strong") {
    return <CheckCircle2 className="h-4 w-4" aria-hidden="true" />;
  }

  if (status === "Minor leak") {
    return <Gauge className="h-4 w-4" aria-hidden="true" />;
  }

  return <AlertTriangle className="h-4 w-4" aria-hidden="true" />;
}

export function CategoryBreakdown({ categories, weakestIds }: CategoryBreakdownProps) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {categories.map((category) => {
        const isWeakest = weakestIds.includes(category.id);

        return (
          <article
            key={category.id}
            className={clsx(
              "print-panel rounded-lg border bg-ink-850 p-5",
              isWeakest ? "border-electric-400/55 shadow-blue-glow" : "border-white/10"
            )}
          >
            <div className="mb-5 flex items-start justify-between gap-4">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-xl font-semibold text-white">{category.name}</h3>
                  {isWeakest ? (
                    <span className="rounded-full border border-electric-400/35 bg-electric-500/10 px-2 py-1 text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-electric-300">
                      Top constraint
                    </span>
                  ) : null}
                </div>
                <p className="mt-2 text-sm leading-6 text-slate-400 print-muted">
                  {category.definition}
                </p>
              </div>
              <ScoreBadge percentage={category.percentage} label="Leak" size="sm" />
            </div>

            <div className="mb-4 flex flex-wrap items-center gap-2">
              <span
                className={clsx(
                  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold",
                  statusStyle(category.status)
                )}
              >
                <StatusIcon status={category.status} />
                {category.status}
              </span>
              <span className="text-sm text-slate-400">
                {category.rawScore}/12 category score
              </span>
            </div>

            <div className="h-2 overflow-hidden rounded-full bg-white/10" aria-hidden="true">
              <div
                className="h-full rounded-full bg-electric-400"
                style={{ width: `${category.percentage}%` }}
              />
            </div>

            <div className="mt-5 space-y-4 text-sm leading-6">
              <div>
                <p className="font-semibold text-white">Diagnosis</p>
                <p className="mt-1 text-slate-300 print-muted">{category.diagnosis}</p>
              </div>
              <div>
                <p className="font-semibold text-white">Recommended next action</p>
                <p className="mt-1 text-slate-300 print-muted">
                  {category.recommendedAction}
                </p>
              </div>
            </div>
          </article>
        );
      })}
    </div>
  );
}

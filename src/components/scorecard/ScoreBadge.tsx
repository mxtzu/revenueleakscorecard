import clsx from "clsx";

type ScoreBadgeProps = {
  percentage: number;
  label?: string;
  size?: "sm" | "lg";
};

export function ScoreBadge({ percentage, label = "Score", size = "lg" }: ScoreBadgeProps) {
  return (
    <div
      className={clsx(
        "score-ring relative grid shrink-0 place-items-center rounded-full p-[1px]",
        size === "lg" ? "h-44 w-44 sm:h-52 sm:w-52" : "h-20 w-20"
      )}
      style={{ "--score": percentage } as React.CSSProperties}
      aria-label={`${label}: ${percentage}%`}
    >
      <div className="grid h-full w-full place-items-center rounded-full bg-ink-950 text-center">
        <div>
          <div
            className={clsx(
              "font-semibold text-white",
              size === "lg" ? "text-5xl" : "text-xl"
            )}
          >
            {percentage}%
          </div>
          <div
            className={clsx(
              "mt-1 text-[0.68rem] uppercase tracking-[0.18em] text-slate-400",
              size === "sm" && "tracking-[0.08em]"
            )}
          >
            {label}
          </div>
        </div>
      </div>
    </div>
  );
}

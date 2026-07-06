import clsx from "clsx";
import { CATEGORY_NAME, CATEGORY_QUALIFIER } from "@/lib/brand";

type CategoryNameLabelProps = {
  /** Show the "For Roblox Studios" qualifier after the category name. */
  withQualifier?: boolean;
  className?: string;
};

/**
 * The named-category eyebrow (P1 fix #1). One component so the category
 * name renders identically everywhere it appears — hero and audit CTA.
 */
export function CategoryNameLabel({ withQualifier = false, className }: CategoryNameLabelProps) {
  return (
    <p className={clsx("label-mono text-electric-400", className)}>
      {CATEGORY_NAME}
      {withQualifier ? (
        <span className="text-slate-500"> · {CATEGORY_QUALIFIER}</span>
      ) : null}
    </p>
  );
}

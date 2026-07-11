import clsx from "clsx";
import { BrandMark } from "@/components/scorecard/BrandMark";
import { BRAND_NAME } from "@/lib/brand";

type LogoProps = {
  className?: string;
};

/**
 * Header lockup: the A mark + the ASCEND wordmark. The wordmark is set in the
 * site's letter-spaced mono to echo the outlined brand wordmark without
 * shipping a second font. Swap the text span for an SVG wordmark here if a
 * pixel-exact wordmark asset lands later.
 */
export function Logo({ className }: LogoProps) {
  return (
    <span className={clsx("inline-flex items-center gap-2.5 text-white", className)}>
      <BrandMark className="h-[15px] w-auto" />
      <span className="label-mono text-[0.8125rem] leading-none">{BRAND_NAME}</span>
    </span>
  );
}

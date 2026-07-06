/**
 * CMS-light proof module config (P1 fix #3).
 *
 * The proof strip above the audit CTA renders from this object only.
 * When the STRAFE (Droplet Studios) numbers clear verification, set
 * `verified: true` and fill `stat` / `statLabel` — one config change,
 * no component work.
 *
 * Rules baked into the component:
 * - `stat` is only rendered when `verified` is true. An unverified stat
 *   never ships, even if someone fills it in early.
 * - No timing claims (days-to-delivery etc.) belong in `claim` until
 *   they are substantiated.
 */
export type ProofConfig = {
  verified: boolean;
  /** The credibility claim. Must hold without any numbers attached. */
  claim: string;
  /** Verified headline stat, e.g. "+38%". Rendered only when verified. */
  stat: string | null;
  /** What the stat measures, e.g. "Payer Conversion Lift". */
  statLabel: string | null;
  /** Who the work was for, as it should appear publicly. */
  source: string;
};

export const proofConfig: ProofConfig = {
  verified: false,
  claim:
    "Delivered a full build guide to a live Roblox FPS studio — grounded entirely in their own funnel data, not templates.",
  stat: null,
  statLabel: null,
  source: "Live client engagement"
};

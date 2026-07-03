import type { TrackingContext } from "@/lib/tracking";

export const REVENUE_LEAK_APPLICATION_URL =
  "https://ascend-revenue-os.vercel.app/revenue-leak-application";

/**
 * Builds the audit application URL with the scorecard session and source
 * attribution attached, so the click→scorecard→audit stages join up in
 * funnel reporting.
 */
export function getAuditUrl(context: TrackingContext | null, leakCategory?: string) {
  const url = new URL(REVENUE_LEAK_APPLICATION_URL);

  if (context) {
    url.searchParams.set("sc_session", context.sessionId);
    Object.entries(context.utm).forEach(([key, value]) => {
      url.searchParams.set(key, value);
    });
  }

  if (leakCategory) {
    url.searchParams.set("sc_leak", leakCategory);
  }

  return url.toString();
}

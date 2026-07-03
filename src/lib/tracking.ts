import type { LeakResult } from "@/types/scorecard";

const TRACKING_STORAGE_KEY = "ascend-revenue-leak-scorecard-attribution";

export type TrackingContext = {
  sessionId: string;
  firstSeenAt: string;
  landingPage: string;
  currentPage: string;
  referrer: string;
  utm: Record<string, string>;
};

type EventPayload = Record<string, string | number | boolean | null | undefined>;

declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void;
    posthog?: {
      capture: (eventName: string, payload?: Record<string, unknown>) => void;
    };
    plausible?: (eventName: string, options?: { props?: Record<string, unknown> }) => void;
  }
}

function getSessionId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }

  return `session_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function getUtmParams(search: string) {
  const params = new URLSearchParams(search);
  const utm: Record<string, string> = {};

  params.forEach((value, key) => {
    if (key.startsWith("utm_") || key === "gclid" || key === "fbclid" || key === "ref") {
      utm[key] = value;
    }
  });

  return utm;
}

function readStoredContext() {
  const stored = window.localStorage.getItem(TRACKING_STORAGE_KEY);
  if (!stored) return null;

  try {
    return JSON.parse(stored) as TrackingContext;
  } catch {
    window.localStorage.removeItem(TRACKING_STORAGE_KEY);
    return null;
  }
}

export function getTrackingContext(): TrackingContext | null {
  if (typeof window === "undefined") return null;

  const existing = readStoredContext();
  const currentPage = window.location.href;

  if (existing) {
    const updated = { ...existing, currentPage };
    window.localStorage.setItem(TRACKING_STORAGE_KEY, JSON.stringify(updated));
    return updated;
  }

  const context: TrackingContext = {
    sessionId: getSessionId(),
    firstSeenAt: new Date().toISOString(),
    landingPage: currentPage,
    currentPage,
    referrer: document.referrer,
    utm: getUtmParams(window.location.search)
  };

  window.localStorage.setItem(TRACKING_STORAGE_KEY, JSON.stringify(context));
  return context;
}

export function getResultEventPayload(result: LeakResult): EventPayload {
  const scores = Object.fromEntries(
    result.scores.map((entry) => [`score_${entry.category.id}`, entry.score])
  );

  return {
    leakCategory: result.leak.category.id,
    leakStatus: result.leak.status,
    totalScore: result.totalScore,
    revenueBand: result.revenueBandValue,
    ...scores
  };
}

export function trackScorecardEvent(eventName: string, payload: EventPayload = {}) {
  if (typeof window === "undefined") return;

  const context = getTrackingContext();
  const cleanedPayload = Object.fromEntries(
    Object.entries(payload).filter(([, value]) => value !== undefined)
  );

  window.gtag?.("event", eventName, cleanedPayload);
  window.posthog?.capture(eventName, { ...cleanedPayload, trackingContext: context });
  window.plausible?.(eventName, { props: cleanedPayload });

  const eventBody = JSON.stringify({
    eventName,
    payload: cleanedPayload,
    trackingContext: context
  });

  if ("sendBeacon" in navigator) {
    const sent = navigator.sendBeacon(
      "/api/scorecard-events",
      new Blob([eventBody], { type: "application/json" })
    );

    if (sent) return;
  }

  void fetch("/api/scorecard-events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: eventBody,
    keepalive: true
  }).catch(() => undefined);
}

/**
 * Logs a completed scorecard session (scores + surfaced leak + attribution)
 * to the funnel store. Fire-and-forget; never blocks the UI.
 */
export function logScorecardSession(input: {
  completionId: string;
  result: LeakResult;
  answers: Record<string, number>;
}) {
  if (typeof window === "undefined") return;

  void fetch("/api/scorecard-sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      completionId: input.completionId,
      result: {
        leakCategory: input.result.leak.category.id,
        totalScore: input.result.totalScore,
        revenueBand: input.result.revenueBandValue,
        scores: Object.fromEntries(
          input.result.scores.map((entry) => [entry.category.id, entry.score])
        )
      },
      answers: input.answers,
      trackingContext: getTrackingContext()
    }),
    keepalive: true
  }).catch(() => undefined);
}

export async function submitScorecardLead(input: {
  completionId: string;
  email: string;
  discordUsername: string;
  answers: Record<string, number>;
  result: LeakResult;
}) {
  const response = await fetch("/api/scorecard-submissions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      completionId: input.completionId,
      email: input.email,
      discordUsername: input.discordUsername,
      answers: input.answers,
      result: {
        leakCategory: input.result.leak.category.id,
        leakHeadline: input.result.leak.category.leak.headline,
        totalScore: input.result.totalScore,
        revenueBand: input.result.revenueBandValue,
        scores: Object.fromEntries(
          input.result.scores.map((entry) => [entry.category.id, entry.score])
        )
      },
      trackingContext: getTrackingContext()
    })
  });

  if (!response.ok) {
    throw new Error("Scorecard submission failed.");
  }

  return response.json() as Promise<{ ok: boolean }>;
}

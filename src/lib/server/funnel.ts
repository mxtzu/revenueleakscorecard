import { supabaseInsert, supabaseSelect, supabaseUpdate } from "@/lib/server/supabase";

/**
 * Funnel logging against the "Content" Supabase project.
 *
 * Confirmed schema (public):
 * - content_tracked_links: slug (unique), utm_* columns
 * - content_link_clicks:   tracked_link_id, session_id, referrer, ...
 * - content_leads:         email, handle, stage enum
 *                          (clicked → scorecard_started → scorecard_completed →
 *                           audit_requested → call_booked → ...), per-stage timestamps
 * - scorecard_sessions:    added by this rebuild — per-session category scores,
 *                          surfaced leak, UTM/source, joins to the above via
 *                          session_id / tracked_link_slug / email
 */

export type TrackingContextInput = {
  sessionId?: string;
  firstSeenAt?: string;
  landingPage?: string;
  referrer?: string;
  utm?: Record<string, string>;
} | null;

export type ScorecardResultInput = {
  leakCategory?: string;
  totalScore?: number;
  revenueBand?: string | null;
  scores?: Record<string, number>;
};

function getString(value: unknown) {
  return typeof value === "string" ? value : null;
}

function getUtm(context: TrackingContextInput) {
  const utm = context?.utm ?? {};
  return {
    utm_source: getString(utm.utm_source),
    utm_medium: getString(utm.utm_medium),
    utm_campaign: getString(utm.utm_campaign),
    utm_content: getString(utm.utm_content),
    utm_term: getString(utm.utm_term)
  };
}

/** Tracked-link slug candidate: an explicit ref param, else utm_content. */
function getSlugCandidate(context: TrackingContextInput) {
  return getString(context?.utm?.ref) ?? getString(context?.utm?.utm_content);
}

export async function logScorecardSession(input: {
  /** Client-generated UUID for this completion; lets the email capture attach contact info later. */
  completionId?: string | null;
  result: ScorecardResultInput;
  answers: Record<string, number>;
  trackingContext: TrackingContextInput;
  email?: string | null;
  discordUsername?: string | null;
}) {
  const { result, trackingContext } = input;
  const scores = result.scores ?? {};

  return supabaseInsert("scorecard_sessions", {
    ...(input.completionId ? { id: input.completionId } : {}),
    session_id: trackingContext?.sessionId ?? null,
    tracked_link_slug: getSlugCandidate(trackingContext),
    ...getUtm(trackingContext),
    referrer: trackingContext?.referrer ?? null,
    landing_page: trackingContext?.landingPage ?? null,
    revenue_band: result.revenueBand ?? null,
    score_acquisition: scores.acquisition ?? null,
    score_activation: scores.activation ?? null,
    score_monetization: scores.monetization ?? null,
    score_measurement: scores.measurement ?? null,
    score_compounding: scores.compounding ?? null,
    total_score: result.totalScore ?? null,
    leak_category: result.leakCategory ?? null,
    answers: input.answers,
    email: input.email ?? null,
    discord_username: input.discordUsername ?? null,
    completed_at: new Date().toISOString()
  });
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Attaches contact details to the session row logged at completion time. */
export async function attachContactToSession(input: {
  completionId: string;
  email: string;
  discordUsername: string;
}) {
  if (!UUID_PATTERN.test(input.completionId)) {
    return { configured: true, inserted: false, error: "Invalid completionId." };
  }

  return supabaseUpdate("scorecard_sessions", `id=eq.${input.completionId}`, {
    email: input.email,
    discord_username: input.discordUsername
  });
}

/**
 * Records the captured lead in content_leads at stage scorecard_completed,
 * linking back to the tracked link when the slug resolves. Updates the
 * existing lead for the email if there is one instead of duplicating it.
 */
export async function upsertScorecardLead(input: {
  email: string;
  discordUsername: string;
  leakCategory?: string;
  trackingContext: TrackingContextInput;
}) {
  const slug = getSlugCandidate(input.trackingContext);
  let trackedLinkId: string | null = null;

  if (slug) {
    const links = await supabaseSelect<{ id: string }>(
      "content_tracked_links",
      `select=id&slug=eq.${encodeURIComponent(slug)}&limit=1`
    );
    trackedLinkId = links?.[0]?.id ?? null;
  }

  const now = new Date().toISOString();
  const startedAt = input.trackingContext?.firstSeenAt ?? now;
  const note = input.leakCategory
    ? `Scorecard leak: ${input.leakCategory}`
    : "Scorecard completed";

  const existing = await supabaseSelect<{ id: string; stage: string }>(
    "content_leads",
    `select=id,stage&email=eq.${encodeURIComponent(input.email)}&limit=1`
  );

  if (existing?.[0]) {
    // Don't regress a lead that is already past the scorecard stage.
    const laterStages = ["audit_requested", "call_booked", "call_completed", "won", "lost"];
    const patch: Record<string, unknown> = {
      handle: input.discordUsername,
      scorecard_completed_at: now,
      notes: note,
      updated_at: now
    };
    if (!laterStages.includes(existing[0].stage)) {
      patch.stage = "scorecard_completed";
    }

    return supabaseUpdate("content_leads", `id=eq.${existing[0].id}`, patch);
  }

  return supabaseInsert("content_leads", {
    email: input.email,
    handle: input.discordUsername,
    source_tracked_link_id: trackedLinkId,
    stage: "scorecard_completed",
    scorecard_started_at: startedAt,
    scorecard_completed_at: now,
    notes: note
  });
}

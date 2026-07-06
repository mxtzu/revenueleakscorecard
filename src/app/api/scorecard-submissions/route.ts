import { NextRequest, NextResponse } from "next/server";
import {
  attachContactToSession,
  logScorecardSession,
  upsertScorecardLead
} from "@/lib/server/funnel";
import type { ScorecardResultInput, TrackingContextInput } from "@/lib/server/funnel";
import { forwardToWebhook, getRequestContext } from "@/lib/server/webhook";

export const runtime = "nodejs";

type SubmissionRequest = {
  completionId?: string;
  email?: string;
  discordUsername?: string;
  answers?: Record<string, number>;
  result?: ScorecardResultInput & { leakHeadline?: string };
  trackingContext?: TrackingContextInput;
};

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function getUtmFields(trackingContext: TrackingContextInput) {
  const utm = trackingContext?.utm ?? {};
  return {
    utmSource: utm.utm_source ?? "",
    utmMedium: utm.utm_medium ?? "",
    utmCampaign: utm.utm_campaign ?? "",
    utmContent: utm.utm_content ?? "",
    utmTerm: utm.utm_term ?? "",
    referrer: trackingContext?.referrer ?? "",
    landingPage: trackingContext?.landingPage ?? "",
    sessionId: trackingContext?.sessionId ?? ""
  };
}

export async function POST(request: NextRequest) {
  let body: SubmissionRequest;

  try {
    body = (await request.json()) as SubmissionRequest;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON." }, { status: 400 });
  }

  if (!body.email || !emailPattern.test(body.email)) {
    return NextResponse.json({ ok: false, error: "A valid email is required." }, { status: 400 });
  }

  const discordUsername = body.discordUsername?.trim();

  if (!discordUsername) {
    return NextResponse.json(
      { ok: false, error: "A Discord username is required." },
      { status: 400 }
    );
  }

  if (!body.result || typeof body.result.leakCategory !== "string") {
    return NextResponse.json({ ok: false, error: "Result is required." }, { status: 400 });
  }

  const submittedAt = new Date().toISOString();
  const trackingContext = body.trackingContext ?? null;
  const scores = body.result.scores ?? {};

  // Funnel store: attach contact to the session row logged at completion
  // (or log a fresh row if the completion beacon never landed), plus a
  // content_leads stage update.
  const [sessionOutcome, leadOutcome] = await Promise.all([
    body.completionId
      ? attachContactToSession({
          completionId: body.completionId,
          email: body.email,
          discordUsername
        })
      : logScorecardSession({
          result: body.result,
          answers: body.answers ?? {},
          trackingContext,
          email: body.email,
          discordUsername
        }),
    upsertScorecardLead({
      email: body.email,
      discordUsername,
      leakCategory: body.result.leakCategory,
      trackingContext
    })
  ]);

  for (const outcome of [sessionOutcome, leadOutcome]) {
    if (outcome.error) console.error(outcome.error);
  }

  // Zapier-compatible flat payload, preserved from the previous build.
  const webhookUrl =
    process.env.SCORECARD_RESULTS_WEBHOOK_URL ?? process.env.SCORECARD_WEBHOOK_URL;
  const flatFields = {
    email: body.email,
    discordUsername,
    submittedAt,
    leakCategory: body.result.leakCategory,
    leakHeadline: body.result.leakHeadline ?? "",
    totalScore: body.result.totalScore ?? "",
    revenueBand: body.result.revenueBand ?? "",
    scoreAcquisition: scores.acquisition ?? "",
    scoreActivation: scores.activation ?? "",
    scoreMonetization: scores.monetization ?? "",
    scoreMeasurement: scores.measurement ?? "",
    scoreCompounding: scores.compounding ?? "",
    ...getUtmFields(trackingContext)
  };

  let delivered = false;
  try {
    const webhookResult = await forwardToWebhook(webhookUrl, {
      type: "scorecard_submission",
      ...flatFields,
      fields: flatFields,
      answers: body.answers ?? {},
      trackingContext,
      requestContext: getRequestContext(request.headers),
      timestamp: submittedAt
    });
    delivered = webhookResult.delivered;
  } catch {
    delivered = false;
  }

  return NextResponse.json(
    { ok: true, delivered, logged: sessionOutcome.inserted },
    { status: 202 }
  );
}

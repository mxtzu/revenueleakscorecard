import { NextRequest, NextResponse } from "next/server";
import { forwardToWebhook, getRequestContext } from "@/lib/server/webhook";
import type { AnswerMap, ScoreSummary } from "@/types/scorecard";

export const runtime = "nodejs";

type ScorecardSubmissionRequest = {
  email?: string;
  answers?: AnswerMap;
  summary?: ScoreSummary;
  trackingContext?: Record<string, unknown> | null;
};

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(request: NextRequest) {
  let body: ScorecardSubmissionRequest;

  try {
    body = (await request.json()) as ScorecardSubmissionRequest;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON." }, { status: 400 });
  }

  if (!body.email || !emailPattern.test(body.email)) {
    return NextResponse.json({ ok: false, error: "A valid email is required." }, { status: 400 });
  }

  if (!body.summary || typeof body.summary.percentage !== "number") {
    return NextResponse.json({ ok: false, error: "Score summary is required." }, { status: 400 });
  }

  const webhookUrl =
    process.env.SCORECARD_RESULTS_WEBHOOK_URL ?? process.env.SCORECARD_WEBHOOK_URL;

  const submissionPayload = {
    type: "scorecard_submission",
    email: body.email,
    result: {
      rawScore: body.summary.rawScore,
      percentage: body.summary.percentage,
      resultBand: body.summary.band.title,
      weakestCategories: body.summary.weakestCategories.map((category) => ({
        id: category.id,
        name: category.name,
        shortName: category.shortName,
        percentage: category.percentage,
        status: category.status
      })),
      categoryScores: body.summary.categoryScores.map((category) => ({
        id: category.id,
        name: category.name,
        shortName: category.shortName,
        rawScore: category.rawScore,
        percentage: category.percentage,
        status: category.status
      }))
    },
    answers: body.answers ?? {},
    trackingContext: body.trackingContext ?? null,
    requestContext: getRequestContext(request.headers),
    timestamp: new Date().toISOString()
  };

  try {
    const result = await forwardToWebhook(webhookUrl, submissionPayload);
    return NextResponse.json({ ok: true, ...result }, { status: 202 });
  } catch {
    return NextResponse.json(
      { ok: false, delivered: false, configured: true, error: "Webhook delivery failed." },
      { status: 502 }
    );
  }
}

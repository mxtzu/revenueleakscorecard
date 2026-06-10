import { NextRequest, NextResponse } from "next/server";
import { forwardToWebhook, getRequestContext } from "@/lib/server/webhook";

export const runtime = "nodejs";

type ScorecardEventRequest = {
  eventName?: string;
  payload?: Record<string, unknown>;
  trackingContext?: Record<string, unknown> | null;
};

export async function POST(request: NextRequest) {
  let body: ScorecardEventRequest;

  try {
    body = (await request.json()) as ScorecardEventRequest;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON." }, { status: 400 });
  }

  if (!body.eventName) {
    return NextResponse.json({ ok: false, error: "Missing eventName." }, { status: 400 });
  }

  const webhookUrl = process.env.SCORECARD_EVENT_WEBHOOK_URL;
  const eventPayload = {
    type: "scorecard_event",
    eventName: body.eventName,
    payload: body.payload ?? {},
    trackingContext: body.trackingContext ?? null,
    requestContext: getRequestContext(request.headers),
    timestamp: new Date().toISOString()
  };

  try {
    const result = await forwardToWebhook(webhookUrl, eventPayload);
    return NextResponse.json({ ok: true, ...result }, { status: 202 });
  } catch {
    return NextResponse.json(
      { ok: false, delivered: false, configured: true, error: "Webhook delivery failed." },
      { status: 502 }
    );
  }
}

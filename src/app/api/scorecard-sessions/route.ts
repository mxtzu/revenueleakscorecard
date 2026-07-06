import { NextRequest, NextResponse } from "next/server";
import { logScorecardSession } from "@/lib/server/funnel";
import type { ScorecardResultInput, TrackingContextInput } from "@/lib/server/funnel";

export const runtime = "nodejs";

type SessionRequest = {
  completionId?: string;
  result?: ScorecardResultInput;
  answers?: Record<string, number>;
  trackingContext?: TrackingContextInput;
};

export async function POST(request: NextRequest) {
  let body: SessionRequest;

  try {
    body = (await request.json()) as SessionRequest;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON." }, { status: 400 });
  }

  if (!body.result || typeof body.result.leakCategory !== "string") {
    return NextResponse.json({ ok: false, error: "Result is required." }, { status: 400 });
  }

  const outcome = await logScorecardSession({
    completionId: body.completionId ?? null,
    result: body.result,
    answers: body.answers ?? {},
    trackingContext: body.trackingContext ?? null
  });

  if (outcome.error) {
    console.error(outcome.error);
  }

  return NextResponse.json({ ok: true, logged: outcome.inserted }, { status: 202 });
}

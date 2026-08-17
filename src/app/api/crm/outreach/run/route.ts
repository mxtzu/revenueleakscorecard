/**
 * POST /api/crm/outreach/run — one pass of the sending engine.
 *
 * Two callers: a scheduler holding `OUTREACH_RUN_SECRET`, and an admin
 * pressing "run now" in the UI. Both end up in the same `runOutreach`.
 *
 * Fails closed. Without the secret set, the scheduled path answers 503 rather
 * than running unauthenticated — an open endpoint that sends email to strangers
 * is not a thing to leave lying around.
 *
 * POST only. A GET would let a link prefetch start a send.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { runOutreach } from '@/lib/outreach/engine';
import { emailProvider, siteUrl, smsProvider } from '@/lib/outreach/config';
import { isAdmin } from '@/lib/crm/permissions';
import { crmSession } from '@/lib/crm/server';
import { createServiceClient, isCrmConfigured, isServiceRoleConfigured } from '@/lib/crm/supabase';
import { secretMatches } from '@/lib/calendar/webhookAuth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  if (!isCrmConfigured() || !isServiceRoleConfigured()) {
    return NextResponse.json(
      { error: 'The CRM is not fully configured; outreach needs the service-role key.' },
      { status: 503 }
    );
  }

  const bearer = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? null;
  const secret = process.env.OUTREACH_RUN_SECRET;

  if (bearer) {
    if (!secret) {
      return NextResponse.json(
        { error: 'OUTREACH_RUN_SECRET is not set, so scheduled sending is disabled.' },
        { status: 503 }
      );
    }
    if (!secretMatches(bearer, secret)) {
      return NextResponse.json({ error: 'Not authorised.' }, { status: 401 });
    }
  } else {
    // Running the engine by hand is an admin action: it is the one control in
    // the CRM that puts messages in front of strangers.
    const { profile } = await crmSession();
    if (!profile) return NextResponse.json({ error: 'Sign in first.' }, { status: 401 });
    if (!isAdmin(profile)) {
      return NextResponse.json({ error: 'Only an owner or admin can run outreach.' }, { status: 403 });
    }
  }

  try {
    const result = await runOutreach({
      service: createServiceClient(),
      email: emailProvider(),
      sms: smsProvider(),
      siteUrl: siteUrl(request.nextUrl.origin)
    });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}

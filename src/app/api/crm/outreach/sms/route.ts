/**
 * POST /api/crm/outreach/sms — inbound SMS from Twilio.
 *
 * Twilio posts form-encoded and signs the request with HMAC-SHA1 over the URL
 * plus every parameter in key order. The URL it signs is the one configured in
 * the Twilio console, so a proxy that rewrites the host will fail verification
 * — that is the scheme working. `TWILIO_WEBHOOK_URL` exists for exactly that
 * case: state the public URL rather than trusting a forwarded header, which an
 * attacker controls.
 *
 * A reply here is very often the word STOP, so a forged one would suppress a
 * real prospect. Nothing is recorded before the signature verifies.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { claimProviderEvent, recordInbound } from '@/lib/outreach/inbound';
import { verifyTwilioSignature } from '@/lib/outreach/providers';
import { createServiceClient, isCrmConfigured, isServiceRoleConfigured } from '@/lib/crm/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Twilio expects TwiML, and an empty response means "send no auto-reply". */
function noReply(): NextResponse {
  return new NextResponse('<?xml version="1.0" encoding="UTF-8"?><Response></Response>', {
    status: 200,
    headers: { 'content-type': 'text/xml' }
  });
}

export async function POST(request: NextRequest) {
  if (!isCrmConfigured() || !isServiceRoleConfigured()) {
    return NextResponse.json({ error: 'Not configured.' }, { status: 503 });
  }
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) {
    return NextResponse.json({ error: 'TWILIO_AUTH_TOKEN is not set.' }, { status: 503 });
  }

  const form = await request.formData();
  const params: Record<string, string> = {};
  form.forEach((value, key) => {
    params[key] = String(value);
  });

  const url = process.env.TWILIO_WEBHOOK_URL ?? request.nextUrl.href;
  const verified = verifyTwilioSignature({
    authToken,
    url,
    params,
    signature: request.headers.get('x-twilio-signature')
  });
  if (!verified) {
    return NextResponse.json({ error: 'Signature verification failed.' }, { status: 403 });
  }

  const service = createServiceClient();
  const messageSid = params.MessageSid ?? params.SmsMessageSid ?? '';

  const claimed = await claimProviderEvent(service, 'twilio', messageSid, 'sms.inbound');
  if (!claimed) return noReply();

  try {
    await recordInbound(service, {
      channel: 'sms',
      fromPhone: params.From ?? null,
      toPhone: params.To ?? null,
      body: params.Body ?? '',
      provider: 'twilio',
      providerMessageId: messageSid
    });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }

  // Deliberately silent. An auto-reply would be this CRM contacting somebody
  // on its own, which is the one thing it does not do.
  return noReply();
}

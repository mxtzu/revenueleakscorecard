/**
 * POST /api/crm/outreach/email — Resend webhooks.
 *
 * Carries two different things on one endpoint, because that is how Resend
 * delivers them: delivery events (`email.delivered`, `email.bounced`, …) and
 * inbound replies (`email.received`).
 *
 * Nothing is trusted before the signature verifies. A forged `email.received`
 * containing the word "unsubscribe" would suppress a real prospect, and a
 * forged bounce would do the same — so an unsigned POST here is an attempt to
 * corrupt the do-not-contact list, not just noise.
 *
 * The raw body is read first and verified unmodified: re-serialising the JSON
 * changes byte order and every signature then fails.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { claimProviderEvent, recordDeliveryEvent, recordInbound } from '@/lib/outreach/inbound';
import { verifySvixSignature } from '@/lib/outreach/providers';
import { createServiceClient, isCrmConfigured, isServiceRoleConfigured } from '@/lib/crm/supabase';
import { reportError } from '@/lib/observability';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface ResendEvent {
  type?: string;
  created_at?: string;
  data?: {
    email_id?: string;
    to?: string[] | string;
    from?: string;
    subject?: string;
    text?: string;
    html?: string;
    headers?: Record<string, string>;
  };
}

function firstAddress(value: string[] | string | undefined): string | null {
  if (!value) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

export async function POST(request: NextRequest) {
  if (!isCrmConfigured() || !isServiceRoleConfigured()) {
    return NextResponse.json({ error: 'Not configured.' }, { status: 503 });
  }
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) {
    // 503 rather than 200: retrying while somebody fixes the configuration is
    // the behaviour we want.
    return NextResponse.json({ error: 'RESEND_WEBHOOK_SECRET is not set.' }, { status: 503 });
  }

  const body = await request.text();
  const verified = verifySvixSignature({
    secret,
    id: request.headers.get('svix-id'),
    timestamp: request.headers.get('svix-timestamp'),
    signature: request.headers.get('svix-signature'),
    body
  });
  if (!verified) {
    // Never retried, and never logged with the payload — an unverified body is
    // attacker-supplied.
    return NextResponse.json({ error: 'Signature verification failed.' }, { status: 400 });
  }

  let event: ResendEvent;
  try {
    event = JSON.parse(body) as ResendEvent;
  } catch {
    return NextResponse.json({ error: 'Malformed payload.' }, { status: 400 });
  }

  const eventId = request.headers.get('svix-id') ?? '';
  const service = createServiceClient();

  const claimed = await claimProviderEvent(service, 'resend', eventId, event.type ?? 'unknown');
  if (!claimed) return NextResponse.json({ received: true, status: 'duplicate' });

  try {
    if (event.type === 'email.received' || event.type === 'inbound.email') {
      const outcome = await recordInbound(service, {
        channel: 'email',
        fromEmail: event.data?.from ?? null,
        toEmail: firstAddress(event.data?.to),
        subject: event.data?.subject ?? null,
        body: event.data?.text ?? event.data?.html ?? '',
        provider: 'resend',
        providerMessageId: event.data?.email_id ?? eventId,
        inReplyTo: event.data?.headers?.['in-reply-to'] ?? null,
        receivedAt: event.created_at
      });
      return NextResponse.json({ received: true, ...outcome });
    }

    const outcome = await recordDeliveryEvent(service, {
      type: event.type ?? '',
      provider: 'resend',
      providerMessageId: event.data?.email_id ?? '',
      recipient: firstAddress(event.data?.to),
      at: event.created_at
    });
    return NextResponse.json({ received: true, ...outcome });
  } catch (error) {
    // 500 so Resend redelivers once whatever broke is fixed — and reported,
    // because a failing bounce handler means addresses that should have been
    // suppressed are still being mailed.
    await reportError(error, { operation: 'outreach.email_webhook', extra: { type: event.type } });
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}

/**
 * POST /api/crm/stripe/webhook — the only writer of payment status.
 *
 * Three things this route has to get exactly right.
 *
 * THE RAW BODY. The signature is computed over the bytes Stripe sent. Parsing
 * the JSON and re-serialising it changes key order and whitespace, and every
 * signature then fails — so `request.text()` is read first and handed to the
 * SDK unmodified.
 *
 * THE SIGNATURE. `constructEvent` is the SDK's implementation of Stripe's
 * signing scheme, including the timestamp tolerance that stops a captured
 * request being replayed tomorrow. Nothing is trusted before it returns: an
 * unsigned POST to this URL is an attempt to write revenue figures.
 *
 * THE STATUS CODE. Stripe retries anything that is not 2xx, for days. A
 * malformed or unverifiable request gets 400 and is never retried; a genuine
 * event that failed while being applied gets 500 so it comes back. Returning
 * 200 on failure loses the event silently, which for a payment is the worst
 * available outcome.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { applyEvent } from '@/lib/billing/events';
import { isStripeConfigured, isWebhookConfigured, stripeClient } from '@/lib/billing/client';
import { createServiceClient, isServiceRoleConfigured } from '@/lib/crm/supabase';
import { reportError } from '@/lib/observability';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  if (!isStripeConfigured() || !isWebhookConfigured()) {
    // 503, not 200: the deployment is misconfigured, and Stripe retrying is
    // the behaviour we want while it gets fixed.
    return NextResponse.json(
      { error: 'Stripe is not configured on this deployment.' },
      { status: 503 }
    );
  }
  if (!isServiceRoleConfigured()) {
    return NextResponse.json(
      { error: 'SUPABASE_SERVICE_ROLE_KEY is not set; the webhook cannot write.' },
      { status: 503 }
    );
  }

  const signature = request.headers.get('stripe-signature');
  if (!signature) {
    return NextResponse.json({ error: 'Missing stripe-signature.' }, { status: 400 });
  }

  // Bytes as sent. Do not parse before this point.
  const payload = await request.text();

  const stripe = stripeClient();
  let event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      payload,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET as string
    );
  } catch (error) {
    // Bad signature, or outside the tolerance window. Never retryable, and
    // never logged with the payload — an unverified body is attacker-supplied.
    return NextResponse.json(
      { error: `Signature verification failed: ${(error as Error).message}` },
      { status: 400 }
    );
  }

  try {
    const outcome = await applyEvent(createServiceClient(), event);

    if (outcome.status === 'failed') {
      // Money events. A silent failure here means the ledger and Stripe
      // disagree, and nobody finds out until a client is chased for an invoice
      // they already paid.
      await reportError(new Error(outcome.detail), {
        operation: 'stripe.webhook',
        extra: { type: event.type, event_id: event.id }
      });
      // Recorded in `stripe_events` with the reason; 500 so Stripe brings it
      // back once whatever broke is fixed.
      return NextResponse.json(
        { received: true, status: outcome.status, detail: outcome.detail },
        { status: 500 }
      );
    }

    return NextResponse.json({ received: true, ...outcome });
  } catch (error) {
    await reportError(error, { operation: 'stripe.webhook', extra: { type: event.type } });
    return NextResponse.json(
      { error: (error as Error).message },
      { status: 500 }
    );
  }
}

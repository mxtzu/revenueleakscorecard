/**
 * Applying Stripe events to the CRM.
 *
 * This module is the *only* thing that writes `payments.status`. Not because
 * of a convention, but because `payments` and `subscriptions` have no INSERT
 * or UPDATE policy for any CRM role, so nothing else can — the code here runs
 * as the service role after Stripe's signature has been verified.
 *
 * Webhooks are not a queue. Three things have to be handled or the ledger goes
 * wrong in ways nobody notices for a month:
 *
 *   REPLAYS — Stripe re-delivers on any non-2xx and on its own schedule. The
 *   `stripe_events` ledger makes a second delivery a no-op.
 *
 *   OUT-OF-ORDER — `invoice.paid` can arrive before `invoice.finalized`. Every
 *   row carries the `created` time of the last event applied, and older events
 *   are skipped rather than rolling a paid invoice back to open.
 *
 *   UNKNOWN CUSTOMERS — an invoice raised in the Stripe dashboard for someone
 *   who is not a CRM client still gets recorded, with a null client_id, rather
 *   than dropped. Money that exists but is invisible is worse than money that
 *   is unattributed.
 */

import type Stripe from 'stripe';

import type { CrmSupabaseClient } from '@/lib/crm/supabase';

import { invoiceToPayment, shouldApply, subscriptionToRow } from './mapping';
import { fromMinorUnits, fromStripeTime } from './money';

/** Events that change something here. Anything else is recorded and ignored. */
export const HANDLED_EVENTS = [
  'invoice.created',
  'invoice.finalized',
  'invoice.sent',
  'invoice.paid',
  'invoice.payment_succeeded',
  'invoice.payment_failed',
  'invoice.marked_uncollectible',
  'invoice.voided',
  'invoice.updated',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.paused',
  'customer.subscription.resumed',
  'charge.refunded'
] as const;

export type HandledEvent = (typeof HANDLED_EVENTS)[number];

export interface EventOutcome {
  status: 'processed' | 'ignored' | 'duplicate' | 'failed';
  detail: string;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Idempotency ledger
// ---------------------------------------------------------------------------

/**
 * Claim this event, or report that it has already been seen.
 *
 * The insert is the lock: `id` is the primary key, so two concurrent
 * deliveries of the same event race on the database rather than on a
 * read-then-write that both would win.
 */
export async function claimEvent(
  service: CrmSupabaseClient,
  event: Pick<Stripe.Event, 'id' | 'type' | 'api_version' | 'created'>
): Promise<boolean> {
  const { error } = await service.from('stripe_events').insert({
    id: event.id,
    type: event.type,
    api_version: event.api_version ?? null,
    event_created: fromStripeTime(event.created),
    status: 'received'
  });

  if (!error) return true;
  if (/duplicate key|already exists/i.test(error.message)) return false;
  throw new Error(`Could not record the Stripe event: ${error.message}`);
}

async function finishEvent(
  service: CrmSupabaseClient,
  eventId: string,
  outcome: EventOutcome
): Promise<void> {
  await service
    .from('stripe_events')
    .update({
      status: outcome.status === 'duplicate' ? 'ignored' : outcome.status,
      processed_at: new Date().toISOString(),
      error: outcome.status === 'failed' ? outcome.detail : null
    })
    .eq('id', eventId);
}

// ---------------------------------------------------------------------------
// Resolving the CRM side
// ---------------------------------------------------------------------------

/** Which client, if any, a Stripe customer belongs to. */
async function clientIdForCustomer(
  service: CrmSupabaseClient,
  customerId: string | null
): Promise<string | null> {
  if (!customerId) return null;
  const { data } = await service
    .from('clients')
    .select('id')
    .eq('stripe_customer_id', customerId)
    .maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}

async function subscriptionRowId(
  service: CrmSupabaseClient,
  stripeSubscriptionId: string | null
): Promise<string | null> {
  if (!stripeSubscriptionId) return null;
  const { data } = await service
    .from('subscriptions')
    .select('id')
    .eq('stripe_subscription_id', stripeSubscriptionId)
    .maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

/**
 * Write an invoice into `payments`.
 *
 * Exported and used by the server actions too: when the CRM asks Stripe to
 * create or send an invoice, Stripe's response goes through exactly this
 * function. The row is always built from a Stripe object, never from a form —
 * which is what "Stripe is the source of truth" has to mean in practice, not
 * just "the webhook exists".
 */
export async function recordInvoice(
  service: CrmSupabaseClient,
  invoice: Stripe.Invoice,
  options: { eventAt?: string | null } = {}
): Promise<{ applied: boolean; detail: string }> {
  const row = invoiceToPayment(invoice, { eventAt: options.eventAt });

  const { data: existing } = await service
    .from('payments')
    .select('id, last_event_at')
    .eq('stripe_invoice_id', row.stripe_invoice_id)
    .maybeSingle();

  const previous = existing as { id: string; last_event_at: string | null } | null;

  if (previous && !shouldApply(options.eventAt, previous.last_event_at)) {
    return { applied: false, detail: 'A later event has already been applied.' };
  }

  const clientId = await clientIdForCustomer(service, row.stripe_customer_id);
  const subscriptionId = await subscriptionRowId(service, row.stripe_subscription_id);

  const payload = { ...row, client_id: clientId, subscription_id: subscriptionId };

  if (previous) {
    const { error } = await service.from('payments').update(payload).eq('id', previous.id);
    if (error) throw new Error(`Could not update the invoice: ${error.message}`);
    return { applied: true, detail: `Updated invoice ${row.stripe_invoice_id} (${row.status}).` };
  }

  const { error } = await service.from('payments').insert(payload);
  if (error) {
    // A concurrent delivery inserted it first. The unique index on
    // stripe_invoice_id is doing its job; the other request has the same data.
    if (/duplicate key/i.test(error.message)) {
      return { applied: false, detail: 'Another delivery recorded this invoice first.' };
    }
    throw new Error(`Could not record the invoice: ${error.message}`);
  }
  return { applied: true, detail: `Recorded invoice ${row.stripe_invoice_id} (${row.status}).` };
}

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------
export async function recordSubscription(
  service: CrmSupabaseClient,
  subscription: Stripe.Subscription,
  options: { eventAt?: string | null } = {}
): Promise<{ applied: boolean; detail: string }> {
  const row = subscriptionToRow(subscription, { eventAt: options.eventAt });

  const { data: existing } = await service
    .from('subscriptions')
    .select('id, last_event_at')
    .eq('stripe_subscription_id', row.stripe_subscription_id)
    .maybeSingle();

  const previous = existing as { id: string; last_event_at: string | null } | null;

  if (previous && !shouldApply(options.eventAt, previous.last_event_at)) {
    return { applied: false, detail: 'A later event has already been applied.' };
  }

  const clientId = await clientIdForCustomer(service, row.stripe_customer_id);
  const payload = { ...row, client_id: clientId };

  if (previous) {
    const { error } = await service.from('subscriptions').update(payload).eq('id', previous.id);
    if (error) throw new Error(`Could not update the subscription: ${error.message}`);
    return {
      applied: true,
      detail: `Updated subscription ${row.stripe_subscription_id} (${row.status}).`
    };
  }

  const { error } = await service.from('subscriptions').insert(payload);
  if (error) {
    if (/duplicate key/i.test(error.message)) {
      return { applied: false, detail: 'Another delivery recorded this subscription first.' };
    }
    throw new Error(`Could not record the subscription: ${error.message}`);
  }
  return {
    applied: true,
    detail: `Recorded subscription ${row.stripe_subscription_id} (${row.status}).`
  };
}

// ---------------------------------------------------------------------------
// Refunds
// ---------------------------------------------------------------------------

/**
 * A refund does not change the invoice's Stripe status — a fully refunded
 * invoice is still `paid` — so it has to be read from the charge and written
 * onto the payment, or refunded money keeps counting as collected.
 *
 * `amount_refunded` is set, not incremented: Stripe sends the running total on
 * every `charge.refunded`, and adding to it would double-count a redelivery.
 */
export async function recordRefund(
  service: CrmSupabaseClient,
  charge: Stripe.Charge,
  options: { eventAt?: string | null } = {}
): Promise<{ applied: boolean; detail: string }> {
  const refunded = fromMinorUnits(charge.amount_refunded, charge.currency) ?? 0;

  // This API version dropped `charge.invoice`; the link that survives is the
  // payment intent. Older payloads still carry the invoice id, so both are
  // read — a redelivery of an event created under the previous version must
  // still find its row.
  const legacy = charge as unknown as { invoice?: string | { id: string } | null };
  const invoiceId =
    typeof legacy.invoice === 'string' ? legacy.invoice : (legacy.invoice?.id ?? null);
  const intentId =
    typeof charge.payment_intent === 'string'
      ? charge.payment_intent
      : (charge.payment_intent?.id ?? null);

  const lookup = service.from('payments').select('id, amount_paid, last_event_at').limit(1);
  const { data } = invoiceId
    ? await lookup.eq('stripe_invoice_id', invoiceId)
    : intentId
      ? await lookup.eq('stripe_payment_intent_id', intentId)
      : await lookup.eq('stripe_charge_id', charge.id);

  const payment = ((data ?? [])[0] ?? null) as
    | { id: string; amount_paid: number | null; last_event_at: string | null }
    | null;

  if (!payment) {
    return { applied: false, detail: `No recorded invoice for charge ${charge.id}.` };
  }
  if (!shouldApply(options.eventAt, payment.last_event_at)) {
    return { applied: false, detail: 'A later event has already been applied.' };
  }

  const { error } = await service
    .from('payments')
    .update({
      amount_refunded: refunded,
      status: refunded > 0 ? 'refunded' : 'paid',
      stripe_charge_id: charge.id,
      last_event_at: options.eventAt ?? null
    })
    .eq('id', payment.id);
  if (error) throw new Error(`Could not record the refund: ${error.message}`);

  return { applied: true, detail: `Recorded a refund of ${refunded} on ${charge.id}.` };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * Apply one verified event.
 *
 * Claims it first, so a redelivery short-circuits before touching anything.
 * The outcome is written back to the ledger either way — a failed event that
 * leaves no trace is one nobody goes looking for.
 */
export async function applyEvent(
  service: CrmSupabaseClient,
  event: Stripe.Event
): Promise<EventOutcome> {
  const claimed = await claimEvent(service, event);
  if (!claimed) {
    return { status: 'duplicate', detail: 'Already processed.' };
  }

  const eventAt = fromStripeTime(event.created);
  let outcome: EventOutcome;

  try {
    switch (event.type) {
      case 'invoice.created':
      case 'invoice.finalized':
      case 'invoice.sent':
      case 'invoice.paid':
      case 'invoice.payment_succeeded':
      case 'invoice.payment_failed':
      case 'invoice.marked_uncollectible':
      case 'invoice.voided':
      case 'invoice.updated': {
        const result = await recordInvoice(service, event.data.object as Stripe.Invoice, {
          eventAt
        });
        outcome = { status: result.applied ? 'processed' : 'ignored', detail: result.detail };
        break;
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
      case 'customer.subscription.paused':
      case 'customer.subscription.resumed': {
        const result = await recordSubscription(
          service,
          event.data.object as Stripe.Subscription,
          { eventAt }
        );
        outcome = { status: result.applied ? 'processed' : 'ignored', detail: result.detail };
        break;
      }

      case 'charge.refunded': {
        const result = await recordRefund(service, event.data.object as Stripe.Charge, {
          eventAt
        });
        outcome = { status: result.applied ? 'processed' : 'ignored', detail: result.detail };
        break;
      }

      default:
        outcome = { status: 'ignored', detail: `No handler for ${event.type}.` };
    }
  } catch (error) {
    outcome = { status: 'failed', detail: message(error) };
  }

  await finishEvent(service, event.id, outcome);
  return outcome;
}

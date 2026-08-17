/**
 * Stripe objects → CRM rows.
 *
 * Pure functions, no I/O. This is the layer that decides what "paid" means in
 * the CRM, and it should be provable without a Stripe account.
 *
 * The rule running through all of it: Stripe's own value is stored verbatim in
 * `stripe_status`, and the CRM's `status` is a *reading* of it. Keeping both
 * means a mapping mistake is visible in the data rather than lost, and a status
 * Stripe adds later still lands somewhere truthful.
 */

import type Stripe from 'stripe';

import { fromMinorUnits, fromStripeTime } from './money';
import type { PaymentStatus } from '@/lib/crm/types';

/** Stripe subscription statuses, matching the `crm_subscription_status` enum. */
export const SUBSCRIPTION_STATUSES = [
  'incomplete', 'incomplete_expired', 'trialing', 'active',
  'past_due', 'canceled', 'unpaid', 'paused'
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

function subscriptionStatus(value: string): SubscriptionStatus {
  return (SUBSCRIPTION_STATUSES as readonly string[]).includes(value)
    ? (value as SubscriptionStatus)
    // A status Stripe adds that this build has never seen. `unpaid` is the
    // conservative reading: it shows up as needing attention rather than
    // silently counting towards revenue.
    : 'unpaid';
}

/**
 * Stripe invoice status → the CRM's payment status.
 *
 *   draft        the invoice exists but has not been issued  → pending
 *   open         issued, awaiting payment                    → pending, or
 *                                                              overdue past its due date
 *   paid         settled                                     → paid
 *   void         cancelled before payment                    → cancelled
 *   uncollectible  written off                               → failed
 *
 * A fully refunded invoice is still `paid` at Stripe, so the refund is read
 * from the amounts rather than the status — otherwise money that went back to
 * the client would still be counted as collected.
 */
export function paymentStatusFor(
  invoice: Pick<Stripe.Invoice, 'status' | 'due_date'>,
  amounts: { amountPaid: number | null; amountRefunded: number },
  now: Date = new Date()
): PaymentStatus {
  switch (invoice.status) {
    case 'paid': {
      if (amounts.amountRefunded > 0 && amounts.amountPaid !== null) {
        // Any refund at all shows as refunded. A partial refund reported as a
        // clean "paid" hides the part that came back.
        return 'refunded';
      }
      return 'paid';
    }
    case 'void':
      return 'cancelled';
    case 'uncollectible':
      return 'failed';
    case 'open': {
      const due = invoice.due_date ? invoice.due_date * 1000 : null;
      return due !== null && due < now.getTime() ? 'overdue' : 'pending';
    }
    case 'draft':
    default:
      return 'pending';
  }
}

/** The columns a webhook or an API response writes onto `payments`. */
export interface PaymentRow {
  stripe_invoice_id: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  stripe_payment_intent_id: string | null;
  stripe_charge_id: string | null;
  stripe_status: string | null;
  invoice_number: string | null;
  description: string | null;
  hosted_invoice_url: string | null;
  invoice_pdf_url: string | null;
  amount: number;
  amount_due: number | null;
  amount_paid: number | null;
  amount_refunded: number;
  currency: string;
  status: PaymentStatus;
  due_at: string | null;
  paid_at: string | null;
  voided_at: string | null;
  period_start: string | null;
  period_end: string | null;
  attempt_count: number;
  last_event_at: string | null;
}

/** Stripe expands some fields to objects; take the id either way. */
function idOf(value: string | { id: string } | null | undefined): string | null {
  if (!value) return null;
  return typeof value === 'string' ? value : value.id;
}

export function invoiceToPayment(
  invoice: Stripe.Invoice,
  options: { eventAt?: string | null; now?: Date } = {}
): PaymentRow {
  const currency = invoice.currency ?? 'gbp';
  const amountDue = fromMinorUnits(invoice.amount_due, currency);
  const amountPaid = fromMinorUnits(invoice.amount_paid, currency);
  const amountRefunded = fromMinorUnits(invoice.post_payment_credit_notes_amount ?? 0, currency) ?? 0;

  // `total` rather than `amount_due`: amount_due drops to zero once an invoice
  // is paid, and an invoice list showing every settled row as £0 is useless.
  const total = fromMinorUnits(invoice.total, currency) ?? amountDue ?? 0;

  const status = paymentStatusFor(invoice, { amountPaid, amountRefunded }, options.now);

  // Stripe moved these onto the invoice's payment records in recent API
  // versions; both shapes are read so a version bump does not lose the link.
  const legacy = invoice as unknown as {
    payment_intent?: string | { id: string } | null;
    charge?: string | { id: string } | null;
  };

  return {
    stripe_invoice_id: invoice.id as string,
    stripe_customer_id: idOf(invoice.customer),
    stripe_subscription_id: idOf(
      (invoice as unknown as { subscription?: string | { id: string } | null }).subscription
    ),
    stripe_payment_intent_id: idOf(legacy.payment_intent),
    stripe_charge_id: idOf(legacy.charge),
    stripe_status: invoice.status ?? null,
    invoice_number: invoice.number ?? null,
    description: invoice.description ?? null,
    hosted_invoice_url: invoice.hosted_invoice_url ?? null,
    invoice_pdf_url: invoice.invoice_pdf ?? null,
    amount: total,
    amount_due: amountDue,
    amount_paid: amountPaid,
    amount_refunded: amountRefunded,
    currency,
    status,
    due_at: fromStripeTime(invoice.due_date),
    // status_transitions is Stripe's own record of when it settled; `now` would
    // be the time the webhook happened to be processed, which can be days later
    // after a retry.
    paid_at: fromStripeTime(invoice.status_transitions?.paid_at),
    voided_at: fromStripeTime(invoice.status_transitions?.voided_at),
    period_start: fromStripeTime(invoice.period_start),
    period_end: fromStripeTime(invoice.period_end),
    attempt_count: invoice.attempt_count ?? 0,
    last_event_at: options.eventAt ?? null
  };
}

/** The columns written onto `subscriptions`. */
export interface SubscriptionRow {
  stripe_subscription_id: string;
  stripe_customer_id: string | null;
  stripe_price_id: string | null;
  status: SubscriptionStatus;
  amount: number | null;
  currency: string;
  interval: string | null;
  interval_count: number | null;
  quantity: number | null;
  description: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
  trial_end: string | null;
  cancel_at_period_end: boolean;
  canceled_at: string | null;
  ended_at: string | null;
  last_event_at: string | null;
}

export function subscriptionToRow(
  subscription: Stripe.Subscription,
  options: { eventAt?: string | null } = {}
): SubscriptionRow {
  // The first item is the one denormalised onto the row. Multi-item
  // subscriptions are rare for an agency retainer and the full detail is
  // always a Stripe call away; the amount below sums every item so the total
  // is right even when there is more than one.
  const items = subscription.items?.data ?? [];
  const first = items[0];
  const price = first?.price;
  const currency = price?.currency ?? 'gbp';

  const totalMinor = items.reduce((sum, item) => {
    const unit = item.price?.unit_amount ?? 0;
    return sum + unit * (item.quantity ?? 1);
  }, 0);

  // Stripe moved the period onto subscription items; read the item first and
  // fall back to the subscription so both API versions work.
  const itemPeriod = first as unknown as
    | { current_period_start?: number; current_period_end?: number }
    | undefined;
  const legacy = subscription as unknown as {
    current_period_start?: number;
    current_period_end?: number;
  };

  return {
    stripe_subscription_id: subscription.id,
    stripe_customer_id: idOf(subscription.customer),
    stripe_price_id: price?.id ?? null,
    status: subscriptionStatus(subscription.status),
    amount: items.length > 0 ? fromMinorUnits(totalMinor, currency) : null,
    currency,
    interval: price?.recurring?.interval ?? null,
    interval_count: price?.recurring?.interval_count ?? null,
    quantity: first?.quantity ?? null,
    description: subscription.description ?? null,
    current_period_start: fromStripeTime(
      itemPeriod?.current_period_start ?? legacy.current_period_start
    ),
    current_period_end: fromStripeTime(
      itemPeriod?.current_period_end ?? legacy.current_period_end
    ),
    trial_end: fromStripeTime(subscription.trial_end),
    cancel_at_period_end: Boolean(subscription.cancel_at_period_end),
    canceled_at: fromStripeTime(subscription.canceled_at),
    ended_at: fromStripeTime(subscription.ended_at),
    last_event_at: options.eventAt ?? null
  };
}

/**
 * Should this event be applied, or is it a late delivery?
 *
 * Stripe does not guarantee order. `invoice.paid` arriving before
 * `invoice.finalized` is normal, and applying the older one second would roll
 * a settled invoice back to open — the CRM would then show an unpaid invoice
 * for money that is already in the bank.
 *
 * Equal timestamps are applied: two events can share a second, and skipping
 * them would lose real updates.
 */
export function shouldApply(
  eventAt: string | null | undefined,
  lastEventAt: string | null | undefined
): boolean {
  if (!eventAt) return true;
  if (!lastEventAt) return true;
  return new Date(eventAt).getTime() >= new Date(lastEventAt).getTime();
}

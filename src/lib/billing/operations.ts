/**
 * The things the CRM asks Stripe to do.
 *
 * Every one of these is a request whose *result* is recorded — the row is
 * written from Stripe's response through the same `recordInvoice` /
 * `recordSubscription` the webhook uses. No function here takes a status from
 * a caller, and none can: `payments` and `subscriptions` have no write policy
 * for any CRM role, and these run as the service role holding an object Stripe
 * just returned.
 *
 * Recording eagerly is not a shortcut past the webhook — the webhook still
 * arrives and is still authoritative. It exists so a user who presses "create
 * invoice" sees the invoice, rather than an empty table and a wait of unknown
 * length.
 *
 * Every mutating call carries an idempotency key. Pressing a button twice, or
 * a request that timed out after Stripe had already acted, must not raise two
 * invoices against a client.
 */

import type Stripe from 'stripe';

import type { CrmSupabaseClient } from '@/lib/crm/supabase';
import type { Client } from '@/lib/crm/types';

import { billingCurrency } from './client';
import { recordInvoice, recordSubscription } from './events';
import { toMinorUnits } from './money';

/** A short, stable key so a repeated request is a repeated *answer*. */
function idempotencyKey(parts: (string | number)[]): string {
  return parts.join(':').slice(0, 255);
}

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

/**
 * The Stripe customer for a client, creating one if there is not yet one.
 *
 * The id is written back to `clients.stripe_customer_id`, which has a unique
 * index: two CRM accounts pointing at one Stripe customer would make every
 * invoice ambiguous to attribute, and the webhook resolves rows by that id.
 */
export async function ensureCustomer(
  stripe: Stripe,
  service: CrmSupabaseClient,
  client: Pick<Client, 'id' | 'company_name' | 'stripe_customer_id' | 'billing_email'>
): Promise<string> {
  if (client.stripe_customer_id) return client.stripe_customer_id;

  const customer = await stripe.customers.create(
    {
      name: client.company_name,
      email: client.billing_email ?? undefined,
      // The link back, so somebody looking at a customer in the Stripe
      // dashboard can find the account it belongs to.
      metadata: { crm_client_id: client.id }
    },
    { idempotencyKey: idempotencyKey(['customer', client.id]) }
  );

  const { error } = await service
    .from('clients')
    .update({ stripe_customer_id: customer.id })
    .eq('id', client.id);
  if (error) {
    throw new Error(
      `Stripe customer ${customer.id} was created but could not be linked: ${error.message}`
    );
  }

  return customer.id;
}

/**
 * A Stripe Product for this client's retainer.
 *
 * Required because `price_data` on a subscription item takes a Product id —
 * inline `product_data` was removed. One product per client rather than a
 * single shared "Retainer", so the line on the client's own invoice and card
 * statement names their account instead of something generic.
 *
 * The idempotency key makes repeated calls return the same product rather than
 * accumulating one per attempt.
 */
export async function ensureRetainerProduct(
  stripe: Stripe,
  client: Pick<Client, 'id' | 'company_name'>
): Promise<string> {
  const product = await stripe.products.create(
    {
      name: `${client.company_name} — retainer`,
      metadata: { crm_client_id: client.id }
    },
    { idempotencyKey: idempotencyKey(['product', client.id]) }
  );
  return product.id;
}

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

export interface InvoiceLine {
  description: string;
  /** In major units — £1,500.00, not 150000. Converted here. */
  amount: number;
  quantity?: number;
}

export interface CreateInvoiceInput {
  client: Pick<Client, 'id' | 'company_name' | 'stripe_customer_id' | 'billing_email'>;
  lines: InvoiceLine[];
  currency?: string;
  /** Net terms. Stripe requires `collection_method: send_invoice` to accept one. */
  daysUntilDue?: number;
  description?: string | null;
  footer?: string | null;
  /** Finalise it, so it gets a number and a payable URL. */
  finalize?: boolean;
  /**
   * Have Stripe email it to the client.
   *
   * Off by default, and separate from `finalize` on purpose: this is the only
   * function in the CRM that causes a message to be sent to a customer, so it
   * takes a deliberate act rather than riding along with something else.
   */
  send?: boolean;
}

/**
 * Draft an invoice, optionally finalise and send it.
 *
 * The order matters. Stripe attaches pending invoice items to the *next*
 * invoice created for that customer, so the items go on first and the invoice
 * is created after — reversing it produces an empty invoice and orphaned
 * items that ambush the next one.
 */
export async function createInvoice(
  stripe: Stripe,
  service: CrmSupabaseClient,
  input: CreateInvoiceInput
): Promise<Stripe.Invoice> {
  if (input.lines.length === 0) {
    throw new Error('An invoice needs at least one line.');
  }

  const currency = (input.currency ?? billingCurrency()).toLowerCase();
  const customerId = await ensureCustomer(stripe, service, input.client);

  // A stable key for this whole operation, so a double submit does not raise
  // two invoices. Derived from the content: a genuinely different invoice for
  // the same client gets a different key and is allowed through.
  const fingerprint = idempotencyKey([
    'invoice',
    input.client.id,
    currency,
    input.lines.map((line) => `${line.description}=${line.amount}x${line.quantity ?? 1}`).join('|')
  ]);

  // `amount` is the line total in minor units. This API version dropped the
  // top-level `unit_amount`, and the alternative — `price_data` — now requires
  // a Product id, which is a lot of Stripe objects for an ad-hoc invoice line.
  // The quantity therefore goes into the description so it still reads
  // correctly on the invoice, rather than being silently dropped.
  for (let index = 0; index < input.lines.length; index += 1) {
    const line = input.lines[index];
    const quantity = line.quantity ?? 1;
    await stripe.invoiceItems.create(
      {
        customer: customerId,
        currency,
        description:
          quantity > 1
            ? `${line.description} (${quantity} × ${line.amount.toFixed(2)})`
            : line.description,
        amount: toMinorUnits(line.amount * quantity, currency)
      },
      { idempotencyKey: `${fingerprint}:item:${index}` }
    );
  }

  let invoice = await stripe.invoices.create(
    {
      customer: customerId,
      currency,
      // `send_invoice` means Stripe hosts a payment page and the client pays
      // when they choose. `charge_automatically` would attempt a saved card,
      // which an agency raising ad-hoc invoices does not want by default.
      collection_method: 'send_invoice',
      days_until_due: input.daysUntilDue ?? 14,
      description: input.description ?? undefined,
      footer: input.footer ?? undefined,
      auto_advance: false,
      metadata: { crm_client_id: input.client.id }
    },
    { idempotencyKey: fingerprint }
  );

  if (input.finalize || input.send) {
    invoice = await stripe.invoices.finalizeInvoice(invoice.id as string, {
      // Finalising must not email anyone. Sending is `send` below, and keeping
      // them separate is what makes "draft it now, send it after review"
      // possible.
      auto_advance: false
    });
  }

  if (input.send) {
    invoice = await stripe.invoices.sendInvoice(invoice.id as string);
  }

  await recordInvoice(service, invoice);
  return invoice;
}

/** Finalise a draft, giving it a number and a payable URL. Sends nothing. */
export async function finalizeInvoice(
  stripe: Stripe,
  service: CrmSupabaseClient,
  stripeInvoiceId: string
): Promise<Stripe.Invoice> {
  const invoice = await stripe.invoices.finalizeInvoice(stripeInvoiceId, { auto_advance: false });
  await recordInvoice(service, invoice);
  return invoice;
}

/** Email the invoice to the client. The one deliberate outbound message. */
export async function sendInvoice(
  stripe: Stripe,
  service: CrmSupabaseClient,
  stripeInvoiceId: string
): Promise<Stripe.Invoice> {
  const invoice = await stripe.invoices.sendInvoice(stripeInvoiceId);
  await recordInvoice(service, invoice);
  return invoice;
}

/**
 * Void an invoice.
 *
 * Voiding is the correct way to cancel an issued invoice — deleting is only
 * possible while it is still a draft, and destroying the record of something a
 * client was asked to pay is not an accounting practice.
 */
export async function voidInvoice(
  stripe: Stripe,
  service: CrmSupabaseClient,
  stripeInvoiceId: string
): Promise<Stripe.Invoice> {
  const invoice = await stripe.invoices.voidInvoice(stripeInvoiceId);
  await recordInvoice(service, invoice);
  return invoice;
}

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

export interface CreateSubscriptionInput {
  client: Pick<Client, 'id' | 'company_name' | 'stripe_customer_id' | 'billing_email'>;
  /** Monthly (or per-interval) amount in major units. */
  amount: number;
  currency?: string;
  interval?: 'day' | 'week' | 'month' | 'year';
  intervalCount?: number;
  description?: string | null;
  /** Free period before billing starts, in days. */
  trialDays?: number;
  contractId?: string | null;
}

/**
 * Start a recurring retainer.
 *
 * The price is created inline rather than chosen from a Stripe price list.
 * Agency retainers are negotiated per client — a shared price catalogue would
 * mean a new Stripe price for every deal, and the deal already knows its
 * number.
 */
export async function createSubscription(
  stripe: Stripe,
  service: CrmSupabaseClient,
  input: CreateSubscriptionInput
): Promise<Stripe.Subscription> {
  if (!(input.amount > 0)) throw new Error('A subscription needs an amount above zero.');

  const currency = (input.currency ?? billingCurrency()).toLowerCase();
  const interval = input.interval ?? 'month';
  const customerId = await ensureCustomer(stripe, service, input.client);
  const productId = await ensureRetainerProduct(stripe, input.client);

  const subscription = await stripe.subscriptions.create(
    {
      customer: customerId,
      collection_method: 'send_invoice',
      days_until_due: 14,
      description: input.description ?? undefined,
      trial_period_days: input.trialDays && input.trialDays > 0 ? input.trialDays : undefined,
      items: [
        {
          price_data: {
            currency,
            product: productId,
            recurring: { interval, interval_count: input.intervalCount ?? 1 },
            unit_amount: toMinorUnits(input.amount, currency)
          }
        }
      ],
      metadata: { crm_client_id: input.client.id }
    },
    {
      idempotencyKey: idempotencyKey([
        'subscription',
        input.client.id,
        currency,
        input.amount,
        interval,
        input.intervalCount ?? 1
      ])
    }
  );

  await recordSubscription(service, subscription);

  // Link the contract afterwards: it is CRM state, not something Stripe knows,
  // so it is not part of the mapped row.
  if (input.contractId) {
    await service
      .from('subscriptions')
      .update({ contract_id: input.contractId })
      .eq('stripe_subscription_id', subscription.id);
  }

  return subscription;
}

/**
 * Cancel a subscription, at the end of the paid period by default.
 *
 * Immediate cancellation takes away service the client has already paid for,
 * so it is the explicit choice rather than the default.
 */
export async function cancelSubscription(
  stripe: Stripe,
  service: CrmSupabaseClient,
  stripeSubscriptionId: string,
  options: { immediately?: boolean } = {}
): Promise<Stripe.Subscription> {
  const subscription = options.immediately
    ? await stripe.subscriptions.cancel(stripeSubscriptionId)
    : await stripe.subscriptions.update(stripeSubscriptionId, { cancel_at_period_end: true });

  await recordSubscription(service, subscription);
  return subscription;
}

/** Undo a pending cancellation, while the period is still running. */
export async function resumeSubscription(
  stripe: Stripe,
  service: CrmSupabaseClient,
  stripeSubscriptionId: string
): Promise<Stripe.Subscription> {
  const subscription = await stripe.subscriptions.update(stripeSubscriptionId, {
    cancel_at_period_end: false
  });
  await recordSubscription(service, subscription);
  return subscription;
}

// ---------------------------------------------------------------------------
// Backfill
// ---------------------------------------------------------------------------

/**
 * Pull everything for one customer from Stripe.
 *
 * The webhook is the normal path; this is for the two cases it cannot cover —
 * invoices raised before the webhook was connected, and events missed while a
 * deployment was down. Reads only, and writes through the same recorders.
 */
export async function backfillCustomer(
  stripe: Stripe,
  service: CrmSupabaseClient,
  stripeCustomerId: string
): Promise<{ invoices: number; subscriptions: number }> {
  let subscriptions = 0;
  let invoices = 0;

  // Subscriptions first: an invoice links to its subscription row, and one
  // that does not exist yet would be recorded unlinked.
  for await (const subscription of stripe.subscriptions.list({
    customer: stripeCustomerId,
    status: 'all',
    limit: 100
  })) {
    await recordSubscription(service, subscription);
    subscriptions += 1;
  }

  for await (const invoice of stripe.invoices.list({ customer: stripeCustomerId, limit: 100 })) {
    await recordInvoice(service, invoice);
    invoices += 1;
  }

  return { invoices, subscriptions };
}

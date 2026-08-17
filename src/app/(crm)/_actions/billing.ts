'use server';

/**
 * Billing actions.
 *
 * Every one of these is a *request to Stripe*, and the CRM row that results is
 * written from Stripe's own response. None of them takes a payment status from
 * a form, and none of them could: `payments` and `subscriptions` have no write
 * policy for any CRM role, so the only writes are through the service-role
 * recorders, holding an object Stripe just returned.
 *
 * The service-role client bypasses RLS, so the permission check at the top of
 * each action is load-bearing rather than a courtesy — it is the only thing
 * standing between a viewer and somebody's billing.
 */

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { readableStripeError, stripeClient } from '@/lib/billing/client';
import {
  backfillCustomer,
  cancelSubscription,
  createInvoice,
  createSubscription,
  finalizeInvoice,
  resumeSubscription,
  sendInvoice,
  voidInvoice
} from '@/lib/billing/operations';
import { ValidationError } from '@/lib/crm/errors';
import { safeDestination, withMessage } from '@/lib/crm/redirects';
import { requireWriter } from '@/lib/crm/server';
import { createServiceClient, isServiceRoleConfigured } from '@/lib/crm/supabase';
import type { Client } from '@/lib/crm/types';
import { bool, optionalInt, optionalText, optionalMoney, text, uuid } from '@/lib/crm/validation';

function destination(form: FormData, fallback: string): string {
  // Shared, because six near-identical copies of this check is how one of them
  // ends up missing the backslash case. See src/lib/crm/redirects.ts.
  return safeDestination(form.get('return_to'), fallback);
}

function back(form: FormData, fallback: string, key: 'error' | 'notice', message?: string): never {
  const path = destination(form, fallback);
  if (!message) redirect(path);
  redirect(withMessage(path, key, message));
}

/**
 * Authorise, then load the client under the caller's session.
 *
 * The read goes through RLS, so a row coming back is proof the caller may see
 * it. Everything after this point uses the service role.
 */
async function billableClient(clientId: string): Promise<Client> {
  if (!isServiceRoleConfigured()) {
    throw new ValidationError(
      'SUPABASE_SERVICE_ROLE_KEY is not set, so billing records cannot be written.'
    );
  }
  const { client } = await requireWriter();
  const { data, error } = await client.from('clients').select('*').eq('id', clientId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new ValidationError('That client no longer exists.');
  return data as Client;
}

/** The same guard for actions that act on an invoice or subscription id. */
async function authorise(): Promise<void> {
  if (!isServiceRoleConfigured()) {
    throw new ValidationError(
      'SUPABASE_SERVICE_ROLE_KEY is not set, so billing records cannot be written.'
    );
  }
  await requireWriter();
}

function refresh(clientId?: string | null): void {
  revalidatePath('/payments');
  revalidatePath('/dashboard');
  if (clientId) revalidatePath(`/clients/${clientId}`);
}

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

/**
 * Raise an invoice.
 *
 * Sending is a separate tick-box from finalising, because sending emails the
 * client. Nothing here contacts anybody unless that box is ticked.
 */
export async function draftInvoice(form: FormData) {
  const clientId = uuid(form, 'client_id', 'Client');
  const fallback = `/clients/${clientId}`;
  let notice: string;

  try {
    const client = await billableClient(clientId);

    const description = text(form, 'description', 'Description');
    const amount = optionalMoney(form, 'amount', 'Amount');
    if (amount === null || amount <= 0) {
      throw new ValidationError('An invoice needs an amount above zero.');
    }

    const send = bool(form, 'send');
    const invoice = await createInvoice(stripeClient(), createServiceClient(), {
      client,
      lines: [{ description, amount, quantity: optionalInt(form, 'quantity', 'Quantity', { min: 1 }) ?? 1 }],
      daysUntilDue: optionalInt(form, 'days_until_due', 'Payment terms', { min: 0, max: 365 }) ?? 14,
      description: optionalText(form, 'note'),
      finalize: bool(form, 'finalize') || send,
      send
    });

    notice = send
      ? `Invoice ${invoice.number ?? invoice.id} created and emailed to the client.`
      : `Invoice ${invoice.number ?? invoice.id} created as a ${invoice.status}. Nothing was sent.`;
  } catch (error) {
    back(form, fallback, 'error', readableStripeError(error));
  }

  refresh(clientId);
  back(form, fallback, 'notice', notice);
}

export async function issueInvoice(form: FormData) {
  const fallback = destination(form, '/payments');
  let notice: string;
  try {
    await authorise();
    const invoice = await finalizeInvoice(
      stripeClient(),
      createServiceClient(),
      text(form, 'stripe_invoice_id', 'Invoice')
    );
    notice = `Invoice ${invoice.number ?? invoice.id} finalised. It has a payment link but has not been sent.`;
  } catch (error) {
    back(form, fallback, 'error', readableStripeError(error));
  }
  refresh(optionalText(form, 'client_id'));
  back(form, fallback, 'notice', notice);
}

/** The one action in the CRM that emails a client. */
export async function emailInvoice(form: FormData) {
  const fallback = destination(form, '/payments');
  let notice: string;
  try {
    await authorise();
    const invoice = await sendInvoice(
      stripeClient(),
      createServiceClient(),
      text(form, 'stripe_invoice_id', 'Invoice')
    );
    notice = `Invoice ${invoice.number ?? invoice.id} emailed to the client.`;
  } catch (error) {
    back(form, fallback, 'error', readableStripeError(error));
  }
  refresh(optionalText(form, 'client_id'));
  back(form, fallback, 'notice', notice);
}

export async function cancelInvoice(form: FormData) {
  const fallback = destination(form, '/payments');
  let notice: string;
  try {
    await authorise();
    const invoice = await voidInvoice(
      stripeClient(),
      createServiceClient(),
      text(form, 'stripe_invoice_id', 'Invoice')
    );
    notice = `Invoice ${invoice.number ?? invoice.id} voided. The record is kept.`;
  } catch (error) {
    back(form, fallback, 'error', readableStripeError(error));
  }
  refresh(optionalText(form, 'client_id'));
  back(form, fallback, 'notice', notice);
}

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------
export async function startSubscription(form: FormData) {
  const clientId = uuid(form, 'client_id', 'Client');
  const fallback = `/clients/${clientId}`;
  let notice: string;

  try {
    const client = await billableClient(clientId);
    const amount = optionalMoney(form, 'amount', 'Amount');
    if (amount === null || amount <= 0) {
      throw new ValidationError('A retainer needs an amount above zero.');
    }

    const interval = String(form.get('interval') ?? 'month');
    if (!['day', 'week', 'month', 'year'].includes(interval)) {
      throw new ValidationError('Choose a billing interval Stripe supports.');
    }

    const subscription = await createSubscription(stripeClient(), createServiceClient(), {
      client,
      amount,
      interval: interval as 'day' | 'week' | 'month' | 'year',
      intervalCount: optionalInt(form, 'interval_count', 'Every', { min: 1, max: 12 }) ?? 1,
      description: optionalText(form, 'description'),
      trialDays: optionalInt(form, 'trial_days', 'Trial', { min: 0, max: 365 }) ?? 0,
      contractId: optionalText(form, 'contract_id')
    });

    notice = `Retainer started (${subscription.status}). Stripe will invoice on each cycle.`;
  } catch (error) {
    back(form, fallback, 'error', readableStripeError(error));
  }

  refresh(clientId);
  back(form, fallback, 'notice', notice);
}

export async function endSubscription(form: FormData) {
  const fallback = destination(form, '/payments');
  let notice: string;
  try {
    await authorise();
    const immediately = bool(form, 'immediately');
    await cancelSubscription(
      stripeClient(),
      createServiceClient(),
      text(form, 'stripe_subscription_id', 'Subscription'),
      { immediately }
    );
    notice = immediately
      ? 'Retainer cancelled immediately.'
      : 'Retainer will end when the current period closes. The client keeps what they paid for.';
  } catch (error) {
    back(form, fallback, 'error', readableStripeError(error));
  }
  refresh(optionalText(form, 'client_id'));
  back(form, fallback, 'notice', notice);
}

export async function keepSubscription(form: FormData) {
  const fallback = destination(form, '/payments');
  let notice: string;
  try {
    await authorise();
    await resumeSubscription(
      stripeClient(),
      createServiceClient(),
      text(form, 'stripe_subscription_id', 'Subscription')
    );
    notice = 'Cancellation withdrawn. The retainer continues.';
  } catch (error) {
    back(form, fallback, 'error', readableStripeError(error));
  }
  refresh(optionalText(form, 'client_id'));
  back(form, fallback, 'notice', notice);
}

// ---------------------------------------------------------------------------
// Backfill
// ---------------------------------------------------------------------------

/**
 * Re-read everything for one client from Stripe.
 *
 * The webhook is the normal path. This covers the two cases it cannot: history
 * from before the webhook was connected, and events missed while a deployment
 * was down. Reads only, and writes through the same recorders.
 */
export async function resyncBilling(form: FormData) {
  const clientId = uuid(form, 'client_id', 'Client');
  const fallback = `/clients/${clientId}`;
  let notice: string;

  try {
    const client = await billableClient(clientId);
    if (!client.stripe_customer_id) {
      throw new ValidationError('This client has no Stripe customer yet, so there is nothing to pull.');
    }
    const counts = await backfillCustomer(
      stripeClient(),
      createServiceClient(),
      client.stripe_customer_id
    );
    notice = `Pulled ${counts.invoices} invoice(s) and ${counts.subscriptions} subscription(s) from Stripe.`;
  } catch (error) {
    back(form, fallback, 'error', readableStripeError(error));
  }

  refresh(clientId);
  back(form, fallback, 'notice', notice);
}

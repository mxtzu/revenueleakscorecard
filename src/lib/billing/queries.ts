/**
 * Reads for the payment dashboard.
 *
 * Through the caller's session, so RLS decides what is visible — `payments`
 * and `subscriptions` are readable by any member and writable by nobody.
 */

import 'server-only';

import type { CrmSupabaseClient } from '@/lib/crm/supabase';
import type { Payment, Uuid } from '@/lib/crm/types';

import { monthlyValue } from './money';
import type { SubscriptionStatus } from './mapping';

export interface SubscriptionRecord {
  id: Uuid;
  client_id: Uuid | null;
  contract_id: Uuid | null;
  stripe_subscription_id: string;
  stripe_customer_id: string | null;
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
  created_at: string;
  updated_at: string;
}

/** Statuses that mean money is still expected to arrive. */
export const LIVE_SUBSCRIPTION_STATUSES: SubscriptionStatus[] = ['active', 'trialing', 'past_due'];

export async function listSubscriptions(
  client: CrmSupabaseClient,
  limit = 200
): Promise<SubscriptionRecord[]> {
  const { data, error } = await client
    .from('subscriptions')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`Could not read subscriptions: ${error.message}`);
  return (data ?? []) as SubscriptionRecord[];
}

export async function listSubscriptionsForClient(
  client: CrmSupabaseClient,
  clientId: string
): Promise<SubscriptionRecord[]> {
  const { data, error } = await client
    .from('subscriptions')
    .select('*')
    .eq('client_id', clientId)
    .order('created_at', { ascending: false });
  if (error) throw new Error(`Could not read subscriptions: ${error.message}`);
  return (data ?? []) as SubscriptionRecord[];
}

/**
 * Monthly recurring revenue.
 *
 * Only live subscriptions count. `past_due` is included deliberately — the
 * client has not cancelled and the money is still expected; excluding it makes
 * MRR jump around every time a card is retried.
 */
export function calculateMrr(subscriptions: SubscriptionRecord[]): number {
  return subscriptions
    .filter((subscription) => LIVE_SUBSCRIPTION_STATUSES.includes(subscription.status))
    .reduce((total, subscription) => {
      const monthly = monthlyValue(
        subscription.amount,
        subscription.interval,
        subscription.interval_count
      );
      return total + (monthly ?? 0);
    }, 0);
}

export interface BillingTotals {
  collected: number;
  collectedThisMonth: number;
  outstanding: number;
  overdue: number;
  refunded: number;
  failed: number;
  mrr: number;
  currency: string;
}

/**
 * The dashboard figures.
 *
 * `collected` subtracts refunds rather than reporting gross: money that went
 * back to the client is not revenue, and a headline number that ignores that
 * is the one people quote.
 */
export function billingTotals(
  payments: Payment[],
  subscriptions: SubscriptionRecord[],
  now: Date = new Date()
): BillingTotals {
  const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).getTime();

  let collected = 0;
  let collectedThisMonth = 0;
  let outstanding = 0;
  let overdue = 0;
  let refunded = 0;
  let failed = 0;

  for (const payment of payments) {
    const amount = Number(payment.amount ?? 0);
    const back = Number(payment.amount_refunded ?? 0);

    if (payment.status === 'paid' || payment.status === 'refunded') {
      const net = amount - back;
      collected += net;
      if (payment.paid_at && new Date(payment.paid_at).getTime() >= startOfMonth) {
        collectedThisMonth += net;
      }
    }
    if (back > 0) refunded += back;
    if (payment.status === 'pending') outstanding += amount;
    if (payment.status === 'overdue') {
      overdue += amount;
      // Overdue is still owed, so it belongs in outstanding too — reporting
      // them as separate pots understates what is owed.
      outstanding += amount;
    }
    if (payment.status === 'failed') failed += amount;
  }

  return {
    collected,
    collectedThisMonth,
    outstanding,
    overdue,
    refunded,
    failed,
    mrr: calculateMrr(subscriptions),
    currency: (payments[0]?.currency ?? subscriptions[0]?.currency ?? 'GBP').toUpperCase()
  };
}

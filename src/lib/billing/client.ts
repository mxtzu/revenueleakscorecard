/**
 * The Stripe client.
 *
 * Uses the official SDK, deliberately. The two things most worth not
 * hand-rolling are webhook signature verification and request idempotency, and
 * both are in the box: `webhooks.constructEvent` implements the signing scheme
 * correctly, including the timestamp tolerance that stops a captured request
 * being replayed a day later.
 *
 * The HTTP client is injectable so tests can answer without a network. That is
 * not a fake Stripe — the SDK still builds every request, parses every
 * response and verifies every signature; only the socket is replaced.
 */

import Stripe from 'stripe';

/**
 * The API version every request is pinned to.
 *
 * Pinning matters: unpinned, Stripe would use the account's dashboard default,
 * so somebody clicking "upgrade API version" in a browser would change the
 * shape of every response this code receives.
 *
 * Read from the SDK rather than written as a date string. The SDK already
 * defaults to the version it was generated against, and a hand-typed version
 * the bundled types do not describe is worse than not pinning: the runtime
 * would receive one shape while TypeScript checked against another.
 */
export const STRIPE_API_VERSION = Stripe.API_VERSION;

export type StripeEnv = Record<string, string | undefined>;

export function isStripeConfigured(env: StripeEnv = process.env): boolean {
  return Boolean(env.STRIPE_SECRET_KEY);
}

export function isWebhookConfigured(env: StripeEnv = process.env): boolean {
  return Boolean(env.STRIPE_WEBHOOK_SECRET);
}

/** Test keys and live keys are visibly different; the UI says which is in use. */
export function isLiveMode(env: StripeEnv = process.env): boolean {
  return Boolean(env.STRIPE_SECRET_KEY?.startsWith('sk_live_'));
}

/**
 * The currency invoices are raised in. Lower-case, as Stripe expects.
 *
 * The agency sells in pounds, so GBP is the default rather than Stripe's USD —
 * a currency mismatch is not something to discover on the first invoice.
 */
export function billingCurrency(env: StripeEnv = process.env): string {
  return (env.STRIPE_CURRENCY ?? 'gbp').toLowerCase();
}

export class StripeNotConfiguredError extends Error {
  constructor() {
    super('Stripe is not configured. Set STRIPE_SECRET_KEY. See docs/agency-crm.md.');
    this.name = 'StripeNotConfiguredError';
  }
}

export interface StripeClientOptions {
  env?: StripeEnv;
  /** Replaces the socket, not the SDK. Used by the tests. */
  httpClient?: Stripe.HttpClient;
}

export function stripeClient(options: StripeClientOptions = {}): Stripe {
  const env = options.env ?? process.env;
  const key = env.STRIPE_SECRET_KEY;
  if (!key) throw new StripeNotConfiguredError();

  return new Stripe(key, {
    apiVersion: STRIPE_API_VERSION,
    ...(options.httpClient ? { httpClient: options.httpClient } : {}),
    // Two retries on Stripe's own advice: their client only retries requests it
    // knows are safe to repeat, using the idempotency key it attaches.
    maxNetworkRetries: 2,
    appInfo: { name: 'Agency CRM' }
  });
}

/**
 * Turn a Stripe error into one sentence worth showing.
 *
 * `StripeCardError` and `StripeInvalidRequestError` carry messages written for
 * humans and are passed through. The rest are not — "No such customer:
 * cus_123" is accurate and useless to whoever pressed the button.
 */
export function readableStripeError(error: unknown): string {
  if (error instanceof StripeNotConfiguredError) return error.message;

  const stripeError = error as { type?: string; message?: string; code?: string };
  switch (stripeError?.type) {
    case 'StripeCardError':
    case 'StripeInvalidRequestError':
      return stripeError.message ?? 'Stripe rejected that request.';
    case 'StripeAuthenticationError':
      return 'Stripe rejected the API key. Check STRIPE_SECRET_KEY.';
    case 'StripeConnectionError':
      return 'Could not reach Stripe. Try again in a moment.';
    case 'StripeRateLimitError':
      return 'Stripe is rate limiting this account. Try again shortly.';
    default:
      return error instanceof Error ? error.message : String(error);
  }
}

export type { Stripe };

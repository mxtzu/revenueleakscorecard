/**
 * Offline stand-ins for Stripe and Postgres.
 *
 * The Stripe side replaces the *socket*, not the SDK. Every request is still
 * built by the real Stripe client, every response still parsed by it, and
 * every webhook signature still verified by `constructEvent`. That is the
 * difference between testing an integration offline and writing a fake one:
 * if the SDK would reject a payload or refuse a signature, these tests see it.
 */

import Stripe from 'stripe';

import type { CrmSupabaseClient } from '@/lib/crm/supabase';

type Row = Record<string, unknown>;

interface Condition {
  op: 'eq' | 'in' | 'lt';
  column: string;
  value: unknown;
}

function matches(row: Row, conditions: Condition[]): boolean {
  return conditions.every((condition) => {
    const actual = row[condition.column];
    if (condition.op === 'in') return (condition.value as unknown[]).includes(actual);
    if (condition.op === 'lt') return (actual as number) < (condition.value as number);
    return actual === condition.value;
  });
}

/**
 * In-memory tables with enough PostgREST surface for the billing code.
 *
 * Unique indexes are emulated for the columns that actually carry one, because
 * "a duplicate insert is rejected" is load-bearing behaviour here — it is what
 * makes the event ledger a lock rather than a suggestion.
 */
const UNIQUE_COLUMNS: Record<string, string[]> = {
  stripe_events: ['id'],
  payments: ['stripe_invoice_id'],
  subscriptions: ['stripe_subscription_id']
};

export class FakeDb {
  tables: Record<string, Row[]> = {};

  constructor(seed: Record<string, Row[]> = {}) {
    for (const [table, rows] of Object.entries(seed)) {
      this.tables[table] = rows.map((row) => ({ ...row }));
    }
  }

  rows(table: string): Row[] {
    this.tables[table] ??= [];
    return this.tables[table];
  }

  first(table: string): Row | undefined {
    return this.rows(table)[0];
  }

  private violatesUnique(table: string, row: Row): boolean {
    for (const column of UNIQUE_COLUMNS[table] ?? []) {
      const value = row[column];
      if (value === undefined || value === null) continue;
      if (this.rows(table).some((existing) => existing[column] === value)) return true;
    }
    return false;
  }

  client(): CrmSupabaseClient {
    const db = this;

    const from = (table: string) => {
      const conditions: Condition[] = [];
      let pendingUpdate: Row | null = null;
      let pendingDelete = false;
      let insertError: { message: string } | null = null;

      function selected(): Row[] {
        return db.rows(table).filter((row) => matches(row, conditions));
      }

      function resolve(): { data: unknown; error: unknown } {
        if (insertError) return { data: null, error: insertError };
        if (pendingUpdate) {
          for (const row of selected()) Object.assign(row, pendingUpdate);
          return { data: null, error: null };
        }
        if (pendingDelete) {
          db.tables[table] = db.rows(table).filter((row) => !matches(row, conditions));
          return { data: null, error: null };
        }
        return { data: selected(), error: null };
      }

      const builder: Record<string, unknown> = {
        select: () => builder,
        eq(column: string, value: unknown) {
          conditions.push({ op: 'eq', column, value });
          return builder;
        },
        in(column: string, value: unknown[]) {
          conditions.push({ op: 'in', column, value });
          return builder;
        },
        lt(column: string, value: unknown) {
          conditions.push({ op: 'lt', column, value });
          return builder;
        },
        order: () => builder,
        limit: () => builder,
        insert(payload: Row) {
          if (db.violatesUnique(table, payload)) {
            insertError = {
              message: `duplicate key value violates unique constraint on ${table}`
            };
            return builder;
          }
          db.rows(table).push({ id: payload.id ?? `${table}-${db.rows(table).length + 1}`, ...payload });
          return builder;
        },
        update(payload: Row) {
          pendingUpdate = payload;
          return builder;
        },
        delete() {
          pendingDelete = true;
          return builder;
        },
        maybeSingle: () =>
          Promise.resolve(
            insertError ? { data: null, error: insertError } : { data: selected()[0] ?? null, error: null }
          ),
        single: () =>
          Promise.resolve(
            insertError ? { data: null, error: insertError } : { data: selected()[0] ?? null, error: null }
          ),
        then(done: (value: unknown) => void) {
          done(resolve());
        }
      };

      return builder;
    };

    return { from } as unknown as CrmSupabaseClient;
  }
}

// ---------------------------------------------------------------------------
// Stripe
// ---------------------------------------------------------------------------

export interface RecordedCall {
  method: string;
  path: string;
  body: string;
  headers: Record<string, string>;
}

/**
 * A Stripe HttpClient that answers from a queue and records what was asked.
 *
 * Recording is the point: the idempotency key, the `collection_method`, and
 * whether `auto_advance` was set are all things whose absence is silent and
 * whose presence is the whole behaviour.
 */
export class FakeStripe {
  calls: RecordedCall[] = [];
  private queue: unknown[] = [];

  /** Queue the next response(s), in order. */
  respondWith(...objects: unknown[]): this {
    this.queue.push(...objects);
    return this;
  }

  callsTo(fragment: string): RecordedCall[] {
    return this.calls.filter((call) => call.path.includes(fragment));
  }

  /** Body params, decoded from Stripe's form encoding. */
  paramsOf(call: RecordedCall): URLSearchParams {
    return new URLSearchParams(call.body);
  }

  httpClient(): Stripe.HttpClient {
    const store = this;

    // Stripe's own fetch-based client, given a fetch that never leaves the
    // process. The SDK's request building, encoding, retry logic and error
    // parsing all still run.
    return Stripe.createFetchHttpClient(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const body = typeof init?.body === 'string' ? init.body : '';
      // The SDK hands fetch an array of [name, value] pairs. Normalised to a
      // lower-cased object so a test can ask for a header without caring which
      // shape or casing this version of the SDK happens to use.
      const headers: Record<string, string> = {};
      const raw = init?.headers;
      if (Array.isArray(raw)) {
        for (const [name, value] of raw as [string, string][]) {
          headers[name.toLowerCase()] = value;
        }
      } else if (raw instanceof Headers) {
        raw.forEach((value, name) => {
          headers[name.toLowerCase()] = value;
        });
      } else if (raw) {
        for (const [name, value] of Object.entries(raw as Record<string, string>)) {
          headers[name.toLowerCase()] = value;
        }
      }
      store.calls.push({ method: init?.method ?? 'GET', path: url.pathname + url.search, body, headers });

      const next = store.queue.shift();
      if (next === undefined) {
        return new Response(
          JSON.stringify({ error: { message: `No queued response for ${url.pathname}` } }),
          { status: 500, headers: { 'content-type': 'application/json' } }
        );
      }
      if (next instanceof Error) throw next;

      const payload = next as { __status?: number };
      const status = payload.__status ?? 200;
      return new Response(JSON.stringify(next), {
        status,
        headers: { 'content-type': 'application/json' }
      });
    }) as unknown as Stripe.HttpClient;
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Epoch seconds from a readable date. Raw integers in a fixture are unreadable. */
export function at(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 1000);
}

export const CLIENT_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
export const CUSTOMER_ID = 'cus_test123';

export function crmClientRow(overrides: Row = {}): Row {
  return {
    id: CLIENT_ID,
    company_name: 'Riverside Dental',
    status: 'active',
    stripe_customer_id: CUSTOMER_ID,
    billing_email: 'accounts@riverside.test',
    ...overrides
  };
}

/** A Stripe invoice, in the shape the API actually returns. */
export function stripeInvoice(overrides: Record<string, unknown> = {}): Stripe.Invoice {
  return {
    id: 'in_test123',
    object: 'invoice',
    customer: CUSTOMER_ID,
    currency: 'gbp',
    status: 'open',
    number: 'RIV-0001',
    description: 'September retainer',
    hosted_invoice_url: 'https://invoice.stripe.com/i/test',
    invoice_pdf: 'https://invoice.stripe.com/i/test.pdf',
    total: 150000,
    amount_due: 150000,
    amount_paid: 0,
    attempt_count: 0,
    due_date: at('2026-10-01T00:00:00Z'),
    period_start: at('2026-09-01T00:00:00Z'),
    period_end: at('2026-09-30T00:00:00Z'),
    post_payment_credit_notes_amount: 0,
    status_transitions: {
      finalized_at: at('2026-09-01T00:00:00Z'),
      marked_uncollectible_at: null,
      paid_at: null,
      voided_at: null
    },
    ...overrides
  } as unknown as Stripe.Invoice;
}

export function stripeSubscription(overrides: Record<string, unknown> = {}): Stripe.Subscription {
  return {
    id: 'sub_test123',
    object: 'subscription',
    customer: CUSTOMER_ID,
    status: 'active',
    cancel_at_period_end: false,
    canceled_at: null,
    ended_at: null,
    trial_end: null,
    description: 'Google Ads retainer',
    items: {
      object: 'list',
      data: [
        {
          id: 'si_test',
          quantity: 1,
          current_period_start: at('2026-09-01T00:00:00Z'),
          current_period_end: at('2026-10-01T00:00:00Z'),
          price: {
            id: 'price_test',
            currency: 'gbp',
            unit_amount: 150000,
            recurring: { interval: 'month', interval_count: 1 }
          }
        }
      ]
    },
    ...overrides
  } as unknown as Stripe.Subscription;
}

/**
 * A signed webhook request, built the way Stripe builds one.
 *
 * `generateTestHeaderString` is the SDK's own signer, so a signature that
 * passes here is one that would pass in production.
 */
export function signedEvent(
  event: Record<string, unknown>,
  secret: string,
  options: { timestamp?: number } = {}
): { payload: string; signature: string } {
  const payload = JSON.stringify(event);
  const stripe = new Stripe('sk_test_x');
  const signature = stripe.webhooks.generateTestHeaderString({
    payload,
    secret,
    timestamp: options.timestamp
  });
  return { payload, signature };
}

export function stripeEvent(
  type: string,
  object: unknown,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: `evt_${Math.random().toString(36).slice(2, 10)}`,
    object: 'event',
    api_version: Stripe.API_VERSION,
    created: at('2026-09-21T12:00:00Z'),
    type,
    data: { object },
    ...overrides
  };
}

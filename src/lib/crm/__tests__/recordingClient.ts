/**
 * A Supabase client stand-in that records the query it was asked to build.
 *
 * The filter bug this exists to catch was invisible to any test that mocked the
 * *result*: the code called `.ilike()` with a plausible-looking argument and got
 * plausible-looking rows back. What was wrong was the request — the wrong
 * resource name, and a missing `!inner` — so the request is what gets asserted.
 *
 * This deliberately does not emulate PostgREST. It verifies the half we
 * control; the other half is PostgREST's documented behaviour.
 */

import type { CrmSupabaseClient } from '../supabase';

export interface RecordedFilter {
  op: string;
  column: string;
  value: unknown;
}

export interface RecordedQuery {
  table: string;
  select?: string;
  filters: RecordedFilter[];
  order: { column: string; ascending?: boolean }[];
  limit?: number;
  /** The mutation verb, when the query was a write. */
  write?: 'insert' | 'update' | 'upsert' | 'delete';
  /** The payload handed to that verb. */
  payload?: unknown;
}

/** A recorded `rpc()` call: the function name and the argument object. */
export interface RecordedRpc {
  fn: string;
  args: Record<string, unknown>;
}

export class RecordingClient {
  queries: RecordedQuery[] = [];
  rpcs: RecordedRpc[] = [];

  /** Rows handed back to the caller; the shape rarely matters to these tests. */
  constructor(private rows: unknown[] = []) {}

  get last(): RecordedQuery {
    const query = this.queries[this.queries.length - 1];
    if (!query) throw new Error('No query was issued.');
    return query;
  }

  get lastRpc(): RecordedRpc {
    const call = this.rpcs[this.rpcs.length - 1];
    if (!call) throw new Error('No RPC was issued.');
    return call;
  }

  /** Every filter applied to an embedded resource, by alias prefix. */
  embeddedFilters(alias: string): RecordedFilter[] {
    return this.last.filters.filter((filter) => filter.column.startsWith(`${alias}.`));
  }

  client(): CrmSupabaseClient {
    const store = this;

    const from = (table: string) => {
      const record: RecordedQuery = { table, filters: [], order: [] };
      store.queries.push(record);

      const builder: Record<string, unknown> = {
        select(columns?: string) {
          record.select = columns;
          return builder;
        },
        eq(column: string, value: unknown) {
          record.filters.push({ op: 'eq', column, value });
          return builder;
        },
        neq(column: string, value: unknown) {
          record.filters.push({ op: 'neq', column, value });
          return builder;
        },
        gte(column: string, value: unknown) {
          record.filters.push({ op: 'gte', column, value });
          return builder;
        },
        lte(column: string, value: unknown) {
          record.filters.push({ op: 'lte', column, value });
          return builder;
        },
        ilike(column: string, value: unknown) {
          record.filters.push({ op: 'ilike', column, value });
          return builder;
        },
        in(column: string, value: unknown) {
          record.filters.push({ op: 'in', column, value });
          return builder;
        },
        not(column: string, op: string, value: unknown) {
          record.filters.push({ op: `not.${op}`, column, value });
          return builder;
        },
        order(column: string, options?: { ascending?: boolean }) {
          record.order.push({ column, ascending: options?.ascending });
          return builder;
        },
        limit(count: number) {
          record.limit = count;
          return builder;
        },
        insert(payload: unknown) {
          record.write = 'insert';
          record.payload = payload;
          return builder;
        },
        update(payload: unknown) {
          record.write = 'update';
          record.payload = payload;
          return builder;
        },
        upsert(payload: unknown) {
          record.write = 'upsert';
          record.payload = payload;
          return builder;
        },
        delete() {
          record.write = 'delete';
          return builder;
        },
        maybeSingle() {
          return Promise.resolve({ data: store.rows[0] ?? null, error: null });
        },
        single() {
          return Promise.resolve({ data: store.rows[0] ?? null, error: null });
        },
        // Awaiting the builder resolves it, the way PostgREST's thenable does.
        then(resolve: (value: unknown) => void) {
          resolve({ data: store.rows, error: null });
        }
      };

      return builder;
    };

    // The workflow layer calls stored functions rather than building queries.
    // What matters there is the argument object: Postgres resolves named
    // arguments by name, so a mistyped key is a runtime "function does not
    // exist", not a type error.
    const rpc = (fn: string, args: Record<string, unknown>) => {
      store.rpcs.push({ fn, args });
      return Promise.resolve({ data: store.rows[0] ?? null, error: null });
    };

    return { from, rpc } as unknown as CrmSupabaseClient;
  }
}

/** A client whose every read fails, for testing error propagation. */
export function failingClient(message: string): CrmSupabaseClient {
  const builder: Record<string, unknown> = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (value: unknown) => void) =>
            resolve({ data: null, error: { message } });
        }
        return () => builder;
      }
    }
  );
  return { from: () => builder } as unknown as CrmSupabaseClient;
}

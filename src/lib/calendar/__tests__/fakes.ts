/**
 * Offline stand-ins for Postgres and Google.
 *
 * The sync is the part of this feature most likely to be wrong and least
 * likely to be noticed — a cursor that stops advancing, a conflict resolved
 * the wrong way, a cancellation ignored. None of that shows up in a
 * typecheck, and none of it can be exercised against a real Google account in
 * CI. So both sides get a fake that behaves like the real thing in the ways
 * that matter, and the whole engine runs against them.
 */

import type { CrmSupabaseClient } from '@/lib/crm/supabase';
import type { HttpRequest, HttpResponse, Transport } from '../http';
import type { GoogleEvent } from '../googleCalendar';

type Row = Record<string, unknown>;

interface Condition {
  op: 'eq' | 'in' | 'lt' | 'neq';
  column: string;
  value: unknown;
}

function matches(row: Row, conditions: Condition[]): boolean {
  return conditions.every((condition) => {
    const actual = row[condition.column];
    switch (condition.op) {
      case 'eq':
        return actual === condition.value;
      case 'neq':
        return actual !== condition.value;
      case 'in':
        return (condition.value as unknown[]).includes(actual);
      case 'lt':
        return (actual as number) < (condition.value as number);
    }
  });
}

/**
 * An in-memory table store with just enough PostgREST surface for the sync.
 *
 * Deliberately not a Postgres emulator: RLS, constraints and triggers are
 * asserted in `supabase/tests/`, against a real Postgres. This covers the
 * decisions the TypeScript makes.
 */
export class FakeDb {
  tables: Record<string, Row[]> = {};
  /** Every write, in order — so a test can assert what was *not* written too. */
  writes: { table: string; verb: string; payload: unknown }[] = [];

  constructor(seed: Record<string, Row[]> = {}) {
    for (const [table, rows] of Object.entries(seed)) {
      this.tables[table] = rows.map((row) => ({ ...row }));
    }
  }

  rows(table: string): Row[] {
    this.tables[table] ??= [];
    return this.tables[table];
  }

  find(table: string, id: string): Row | undefined {
    return this.rows(table).find((row) => row.id === id);
  }

  client(): CrmSupabaseClient {
    const db = this;

    const from = (table: string) => {
      const conditions: Condition[] = [];
      let limit: number | null = null;
      let pendingUpdate: Row | null = null;
      let pendingDelete = false;

      function selected(): Row[] {
        const found = db.rows(table).filter((row) => matches(row, conditions));
        return limit === null ? found : found.slice(0, limit);
      }

      function apply(): { data: unknown; error: null } {
        if (pendingUpdate) {
          for (const row of db.rows(table).filter((r) => matches(r, conditions))) {
            Object.assign(row, pendingUpdate);
          }
          return { data: null, error: null };
        }
        if (pendingDelete) {
          db.tables[table] = db.rows(table).filter((row) => !matches(row, conditions));
          return { data: null, error: null };
        }
        return { data: selected(), error: null };
      }

      const builder: Record<string, unknown> = {
        select() {
          return builder;
        },
        eq(column: string, value: unknown) {
          conditions.push({ op: 'eq', column, value });
          return builder;
        },
        neq(column: string, value: unknown) {
          conditions.push({ op: 'neq', column, value });
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
        order() {
          return builder;
        },
        limit(count: number) {
          limit = count;
          return builder;
        },
        insert(payload: Row | Row[]) {
          const list = Array.isArray(payload) ? payload : [payload];
          for (const row of list) {
            db.rows(table).push({ id: row.id ?? `${table}-${db.rows(table).length + 1}`, ...row });
          }
          db.writes.push({ table, verb: 'insert', payload });
          return builder;
        },
        upsert(payload: Row, options?: { onConflict?: string }) {
          const key = options?.onConflict ?? 'id';
          const existing = db.rows(table).find((row) => row[key] === payload[key]);
          if (existing) Object.assign(existing, payload);
          else db.rows(table).push({ ...payload });
          db.writes.push({ table, verb: 'upsert', payload });
          return builder;
        },
        update(payload: Row) {
          pendingUpdate = payload;
          db.writes.push({ table, verb: 'update', payload });
          return builder;
        },
        delete() {
          pendingDelete = true;
          db.writes.push({ table, verb: 'delete', payload: null });
          return builder;
        },
        maybeSingle() {
          return Promise.resolve({ data: selected()[0] ?? null, error: null });
        },
        single() {
          return Promise.resolve({ data: selected()[0] ?? null, error: null });
        },
        then(resolve: (value: unknown) => void) {
          resolve(apply());
        }
      };

      return builder;
    };

    return { from } as unknown as CrmSupabaseClient;
  }
}

// ---------------------------------------------------------------------------
// Google
// ---------------------------------------------------------------------------

export interface FakeGoogleOptions {
  /** Pages returned by events.list, in order. */
  pages?: { items: GoogleEvent[]; nextPageToken?: string; nextSyncToken?: string }[];
  /** Fail the first list call with 410, the way an expired cursor does. */
  expireSyncToken?: boolean;
  /** Status to answer event writes with. */
  writeStatus?: number;
  /** Body for a failing write. */
  writeError?: unknown;
}

/**
 * A transport that answers like Google, and records what it was asked.
 *
 * The recording is the point: `sendUpdates=none` and
 * `conferenceDataVersion=1` are query parameters whose absence is silent and
 * whose presence is the whole behaviour.
 */
export class FakeGoogle {
  requests: HttpRequest[] = [];
  private listCalls = 0;
  private eventSeq = 0;

  constructor(private options: FakeGoogleOptions = {}) {}

  get lastRequest(): HttpRequest {
    const request = this.requests[this.requests.length - 1];
    if (!request) throw new Error('Google was never called.');
    return request;
  }

  requestsTo(fragment: string): HttpRequest[] {
    return this.requests.filter((request) => request.url.includes(fragment));
  }

  transport(): Transport {
    return async (request: HttpRequest): Promise<HttpResponse> => {
      this.requests.push(request);
      const url = new URL(request.url);

      if (url.pathname.endsWith('/token')) {
        return this.json(200, {
          access_token: 'fresh-access-token',
          expires_in: 3600,
          scope: 'https://www.googleapis.com/auth/calendar.events'
        });
      }

      if (url.pathname.includes('/events')) {
        if (request.method === 'GET' && url.pathname.endsWith('/events')) return this.list(url);
        if (request.method === 'POST') return this.write(request, url);
        if (request.method === 'PATCH') return this.write(request, url);
        if (request.method === 'DELETE') return { status: 204, body: '' };
      }

      return this.json(404, { error: { message: `unhandled ${request.method} ${url.pathname}` } });
    };
  }

  private list(url: URL): HttpResponse {
    if (this.options.expireSyncToken && this.listCalls === 0 && url.searchParams.get('syncToken')) {
      this.listCalls += 1;
      return this.json(410, {
        error: { message: 'Sync token is no longer valid', errors: [{ reason: 'fullSyncRequired' }] }
      });
    }
    const page = this.options.pages?.[this.listCalls] ?? { items: [] };
    this.listCalls += 1;
    return this.json(200, {
      items: page.items,
      nextPageToken: page.nextPageToken,
      nextSyncToken: page.nextSyncToken ?? 'sync-token-next'
    });
  }

  private write(request: HttpRequest, url: URL): HttpResponse {
    if (this.options.writeStatus && this.options.writeStatus >= 400) {
      return this.json(this.options.writeStatus, this.options.writeError ?? {
        error: { message: 'Google said no' }
      });
    }

    const sent = JSON.parse(request.body ?? '{}') as GoogleEvent;
    this.eventSeq += 1;
    const id =
      request.method === 'PATCH'
        ? decodeURIComponent(url.pathname.split('/').pop() ?? '')
        : `gcal-event-${this.eventSeq}`;

    const event: GoogleEvent = {
      ...sent,
      id,
      htmlLink: `https://calendar.google.com/event?eid=${id}`,
      updated: '2026-08-17T12:00:00.000Z'
    };

    // A conference is only minted when one was actually requested — mirroring
    // Google, which ignores conferenceData without conferenceDataVersion=1.
    if (sent.conferenceData?.createRequest && url.searchParams.get('conferenceDataVersion') === '1') {
      event.hangoutLink = `https://meet.google.com/${id}`;
      event.conferenceData = {
        conferenceId: id,
        entryPoints: [{ entryPointType: 'video', uri: `https://meet.google.com/${id}` }]
      };
    } else {
      delete event.conferenceData;
    }

    return this.json(200, event);
  }

  private json(status: number, body: unknown): HttpResponse {
    return { status, body: JSON.stringify(body) };
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

export const ACCOUNT_ID = 'cal-account-1';
export const PROFILE_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

export function calendarAccount(overrides: Row = {}): Row {
  return {
    id: ACCOUNT_ID,
    profile_id: PROFILE_ID,
    provider: 'google',
    google_email: 'rep@agency.test',
    calendar_id: 'primary',
    scope: null,
    sync_token: 'sync-token-current',
    channel_id: null,
    channel_resource_id: null,
    channel_expires_at: null,
    last_synced_at: null,
    last_sync_summary: null,
    last_error: null,
    is_active: true,
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
    ...overrides
  };
}

export function appointment(overrides: Row = {}): Row {
  return {
    id: 'appt-1',
    crm_lead_id: null,
    contact_id: null,
    created_by: PROFILE_ID,
    title: 'Discovery call — Riverside Dental',
    starts_at: '2026-09-01T09:00:00.000Z',
    ends_at: '2026-09-01T09:30:00.000Z',
    timezone: 'Europe/London',
    status: 'scheduled',
    calendar_provider: null,
    external_event_id: null,
    google_meet_url: null,
    meeting_notes: null,
    outcome: null,
    created_at: '2026-08-17T10:00:00.000Z',
    updated_at: '2026-08-17T10:00:00.000Z',
    calendar_account_id: ACCOUNT_ID,
    sync_state: 'pending',
    sync_error: null,
    synced_at: null,
    external_updated_at: null,
    external_html_link: null,
    conference_requested: false,
    attendee_emails: [],
    notify_attendees: false,
    ...overrides
  };
}

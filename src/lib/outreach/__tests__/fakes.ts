/**
 * Offline stand-ins for Postgres and the sending providers.
 *
 * The provider fakes record the request rather than emulating a mail server:
 * what matters is that the engine asked for the right thing — the right
 * recipient, an unsubscribe header, a footer — and that it did not ask at all
 * when a gate said no.
 */

import type { CrmSupabaseClient } from '@/lib/crm/supabase';
import type {
  EmailProvider,
  SendEmailInput,
  SendSmsInput,
  SmsProvider
} from '../providers';

type Row = Record<string, unknown>;

interface Condition {
  op: 'eq' | 'in' | 'lt' | 'lte' | 'gte' | 'ilike';
  column: string;
  value: unknown;
}

function matches(row: Row, conditions: Condition[]): boolean {
  return conditions.every((condition) => {
    const actual = row[condition.column];
    switch (condition.op) {
      case 'in':
        return (condition.value as unknown[]).includes(actual);
      case 'lt':
        return String(actual) < String(condition.value);
      case 'lte':
        return actual !== null && actual !== undefined && String(actual) <= String(condition.value);
      case 'gte':
        return actual !== null && actual !== undefined && String(actual) >= String(condition.value);
      case 'ilike':
        return String(actual ?? '').toLowerCase() === String(condition.value).toLowerCase();
      default:
        return actual === condition.value;
    }
  });
}

/** Unique indexes that carry real behaviour in the outreach schema. */
const UNIQUE: Record<string, string[][]> = {
  outreach_messages: [['lead_outreach_id', 'step_id'], ['provider', 'provider_message_id']],
  inbound_messages: [['provider', 'provider_message_id']],
  provider_events: [['id']],
  suppressions: [['email'], ['phone']]
};

export class FakeDb {
  tables: Record<string, Row[]> = {};
  private seq = 0;

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

  find(table: string, id: string): Row | undefined {
    return this.rows(table).find((row) => row.id === id);
  }

  private violates(table: string, row: Row): boolean {
    for (const columns of UNIQUE[table] ?? []) {
      // A composite index does not constrain rows where any part is null,
      // matching Postgres.
      if (columns.some((column) => row[column] === null || row[column] === undefined)) continue;
      if (
        this.rows(table).some((existing) =>
          columns.every((column) => existing[column] === row[column])
        )
      ) {
        return true;
      }
    }
    return false;
  }

  client(): CrmSupabaseClient {
    const db = this;

    const from = (table: string) => {
      const conditions: Condition[] = [];
      let pendingUpdate: Row | null = null;
      let pendingDelete = false;
      let failure: { message: string } | null = null;
      let limit: number | null = null;

      function selected(): Row[] {
        const found = db.rows(table).filter((row) => matches(row, conditions));
        return limit === null ? found : found.slice(0, limit);
      }

      function resolve(): { data: unknown; error: unknown } {
        if (failure) return { data: null, error: failure };
        if (pendingUpdate) {
          for (const row of db.rows(table).filter((r) => matches(r, conditions))) {
            for (const [key, value] of Object.entries(pendingUpdate)) {
              // Supabase drops undefined rather than nulling the column.
              if (value !== undefined) row[key] = value;
            }
          }
          return { data: null, error: null };
        }
        if (pendingDelete) {
          db.tables[table] = db.rows(table).filter((row) => !matches(row, conditions));
          return { data: null, error: null };
        }
        return { data: selected(), error: null };
      }

      const condition = (op: Condition['op']) => (column: string, value: unknown) => {
        conditions.push({ op, column, value });
        return builder;
      };

      let inserted: Row | null = null;

      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: condition('eq'),
        in: condition('in'),
        lt: condition('lt'),
        lte: condition('lte'),
        gte: condition('gte'),
        ilike: condition('ilike'),
        order: () => builder,
        limit(count: number) {
          limit = count;
          return builder;
        },
        insert(payload: Row) {
          if (db.violates(table, payload)) {
            failure = { message: `duplicate key value violates unique constraint on ${table}` };
            return builder;
          }
          db.seq += 1;
          inserted = { id: payload.id ?? `${table}-${db.seq}`, ...payload };
          db.rows(table).push(inserted);
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
            failure
              ? { data: null, error: failure }
              : { data: inserted ?? selected()[0] ?? null, error: null }
          ),
        single: () =>
          Promise.resolve(
            failure
              ? { data: null, error: failure }
              : { data: inserted ?? selected()[0] ?? null, error: null }
          ),
        then(done: (value: unknown) => void) {
          done(resolve());
        }
      };

      return builder;
    };

    // The engine consults the suppression list through the SQL function, so the
    // fake answers it from the same table the real one reads.
    const rpc = (fn: string, args: Record<string, unknown>) => {
      if (fn === 'crm_is_suppressed') {
        const email = String(args.p_email ?? '').trim().toLowerCase();
        const phone = String(args.p_phone ?? '').replace(/[^0-9+]/g, '');
        const hit = db.rows('suppressions').some(
          (row) =>
            (email && String(row.email ?? '').toLowerCase() === email) ||
            (phone && String(row.phone ?? '').replace(/[^0-9+]/g, '') === phone)
        );
        return Promise.resolve({ data: hit, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    };

    return { from, rpc } as unknown as CrmSupabaseClient;
  }
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------
export class FakeEmail implements EmailProvider {
  readonly name = 'fake-email';
  sent: SendEmailInput[] = [];
  failWith: Error | null = null;

  async send(input: SendEmailInput) {
    if (this.failWith) throw this.failWith;
    this.sent.push(input);
    return { providerMessageId: `msg-${this.sent.length}`, provider: this.name };
  }
}

export class FakeSms implements SmsProvider {
  readonly name = 'fake-sms';
  sent: SendSmsInput[] = [];
  failWith: Error | null = null;

  async send(input: SendSmsInput) {
    if (this.failWith) throw this.failWith;
    this.sent.push(input);
    return { providerMessageId: `sms-${this.sent.length}`, provider: this.name };
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
export const LEAD_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
export const SEQUENCE_ID = '9c858901-8a57-4791-81fe-4c455b099bc9';
export const CONTACT_ID = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
export const ENROLMENT_ID = 'enrol-1';

/** A Wednesday at 10:00 UTC — inside the default weekday 09:00–17:00 window. */
export const IN_WINDOW = new Date('2026-09-16T10:00:00Z');

export function settings(overrides: Row = {}): Row {
  return {
    id: true,
    sending_enabled: true,
    from_name: 'Ascend',
    from_email: 'hello@ascend.test',
    reply_to_email: 'hello@ascend.test',
    sms_from_number: '+447700900000',
    postal_address: '1 Example Street, Sunderland SR1 1AA',
    daily_send_limit: 50,
    per_run_limit: 25,
    min_seconds_between_sends: 0,
    send_window_start: 9,
    send_window_end: 17,
    send_on_weekends: false,
    timezone: 'Europe/London',
    ...overrides
  };
}

export function step(overrides: Row = {}): Row {
  return {
    id: 'step-1',
    sequence_id: SEQUENCE_ID,
    step_number: 1,
    channel: 'email',
    delay_minutes: 0,
    subject_template: 'Quick question about {{company_name}}',
    body_template: 'Hi {{first_name}},\n\nI noticed {{top_opportunity}}.\n\n{{sender_name}}',
    task_title: null,
    ignore_send_window: false,
    active: true,
    ...overrides
  };
}

export function enrolment(overrides: Row = {}): Row {
  return {
    id: ENROLMENT_ID,
    crm_lead_id: LEAD_ID,
    sequence_id: SEQUENCE_ID,
    contact_id: CONTACT_ID,
    status: 'active',
    current_step: 0,
    next_step_at: '2026-09-16T09:00:00Z',
    unsubscribe_token: 'tok_abc123',
    started_at: null,
    stopped_at: null,
    stop_reason: null,
    last_error: null,
    last_sent_at: null,
    ...overrides
  };
}

export function lead(overrides: Row = {}): Row {
  return { id: LEAD_ID, pipeline_stage: 'ready_for_outreach', ...overrides };
}

export function intelligence(overrides: Row = {}): Row {
  return {
    crm_lead_id: LEAD_ID,
    company_name: 'Riverside Dental',
    city: 'Sunderland',
    niche: 'invisalign_dental_practices',
    website: 'https://riverside.test',
    business_email: 'info@riverside.test',
    business_phone: '+447700900111',
    contact_name: 'Dana Okafor',
    opportunities: ['no conversion tracking on the booking form'],
    ...overrides
  };
}

export function contact(overrides: Row = {}): Row {
  return {
    id: CONTACT_ID,
    crm_lead_id: LEAD_ID,
    first_name: 'Dana',
    last_name: 'Okafor',
    full_name: 'Dana Okafor',
    job_title: 'Practice Manager',
    email: 'dana@riverside.test',
    phone: '+447700900222',
    ...overrides
  };
}

/** A database seeded for one due email step, ready to send. */
export function seeded(overrides: { steps?: Row[]; extra?: Record<string, Row[]> } = {}): FakeDb {
  return new FakeDb({
    outreach_settings: [settings()],
    outreach_steps: overrides.steps ?? [step()],
    lead_outreach: [enrolment()],
    crm_leads: [lead()],
    lead_intelligence: [intelligence()],
    contacts: [contact()],
    outreach_messages: [],
    activities: [],
    suppressions: [],
    tasks: [],
    inbound_messages: [],
    provider_events: [],
    ...(overrides.extra ?? {})
  });
}

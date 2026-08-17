/**
 * An in-memory stand-in for the slice of supabase-js that `syncLeads` uses.
 *
 * It exists to test the sync's *contract*, not PostgREST. The one behaviour it
 * models faithfully is the thing the contract rests on: `crm_leads.
 * external_lead_id` is UNIQUE, so a second insert of the same id either fails
 * or is ignored — never duplicates. The migration's own SQL suite
 * (supabase/tests/crm_schema_test.sql) asserts that constraint against a real
 * Postgres; here we assert the TypeScript behaves correctly given it.
 *
 * Rows are stored as plain objects and handed back by reference-free copies, so
 * a test that mutates a result cannot corrupt the store.
 */

import type { CrmSupabaseClient } from '../supabase';

interface CrmLeadRow {
  id: string;
  external_lead_id: string;
  pipeline_stage: string;
  owner_id: string | null;
  next_action: string | null;
  [key: string]: unknown;
}

export interface FakeDbOptions {
  /** Fail every `lead_intelligence` upsert with this message. */
  intelligenceError?: string;
  /**
   * Called just before the crm_leads upsert runs, so a test can simulate a
   * competing sync inserting the same external id first.
   */
  beforeLeadInsert?: (db: FakeDb) => void;
}

export class FakeDb {
  leads: CrmLeadRow[] = [];
  intelligence: Record<string, unknown>[] = [];
  /** Every table the client wrote to, in order. Used to prove what is untouched. */
  writes: string[] = [];

  private nextId = 1;

  constructor(private options: FakeDbOptions = {}) {}

  seedLead(externalLeadId: string, overrides: Partial<CrmLeadRow> = {}): CrmLeadRow {
    const row: CrmLeadRow = {
      id: `uuid-${this.nextId++}`,
      external_lead_id: externalLeadId,
      pipeline_stage: 'qualified',
      owner_id: null,
      next_action: null,
      ...overrides
    };
    this.leads.push(row);
    return row;
  }

  /** Insert honouring the UNIQUE constraint. Returns the rows actually created. */
  private insertLeads(rows: Record<string, unknown>[], ignoreDuplicates: boolean) {
    const created: CrmLeadRow[] = [];
    for (const row of rows) {
      const externalId = String(row.external_lead_id);
      if (this.leads.some((existing) => existing.external_lead_id === externalId)) {
        if (ignoreDuplicates) continue;
        return {
          data: null,
          error: {
            message: `duplicate key value violates unique constraint "crm_leads_external_lead_id_key"`
          }
        };
      }
      created.push(this.seedLead(externalId, row as Partial<CrmLeadRow>));
    }
    return { data: created, error: null };
  }

  private upsertIntelligence(rows: Record<string, unknown>[]) {
    if (this.options.intelligenceError) {
      return { data: null, error: { message: this.options.intelligenceError }, count: null };
    }
    for (const row of rows) {
      const key = String(row.crm_lead_id);
      const index = this.intelligence.findIndex((existing) => existing.crm_lead_id === key);
      if (index >= 0) this.intelligence[index] = { ...row };
      else this.intelligence.push({ ...row });
    }
    return { data: null, error: null, count: rows.length };
  }

  /**
   * The query builder. Only the shape syncLeads uses is implemented; anything
   * else throws loudly rather than silently returning nothing, so a future
   * change to the sync cannot pass these tests by accident.
   */
  client(): CrmSupabaseClient {
    const db = this;

    const from = (table: string) => {
      let pendingUpsert: { rows: Record<string, unknown>[]; ignoreDuplicates: boolean } | null =
        null;

      const builder: Record<string, unknown> = {
        select(_columns?: string) {
          if (pendingUpsert) {
            const result = db.insertLeads(pendingUpsert.rows, pendingUpsert.ignoreDuplicates);
            pendingUpsert = null;
            return Promise.resolve(result);
          }
          return builder;
        },

        in(column: string, values: string[]) {
          if (table !== 'crm_leads') throw new Error(`fake db: .in on unsupported table ${table}`);
          const data = db.leads
            .filter((row) => values.includes(String(row[column])))
            .map((row) => ({ id: row.id, external_lead_id: row.external_lead_id }));
          return Promise.resolve({ data, error: null });
        },

        upsert(rows: Record<string, unknown>[], options: Record<string, unknown> = {}) {
          db.writes.push(table);
          if (table === 'crm_leads') {
            db.options.beforeLeadInsert?.(db);
            pendingUpsert = { rows, ignoreDuplicates: Boolean(options.ignoreDuplicates) };
            // Awaited directly (no .select()) it still has to resolve.
            const thenable = {
              ...builder,
              then: (resolve: (value: unknown) => void) => {
                const result = db.insertLeads(rows, Boolean(options.ignoreDuplicates));
                pendingUpsert = null;
                resolve(result);
              }
            };
            return thenable;
          }
          if (table === 'lead_intelligence') return Promise.resolve(db.upsertIntelligence(rows));
          throw new Error(`fake db: upsert on unsupported table ${table}`);
        },

        update() {
          throw new Error(
            `fake db: syncLeads must never UPDATE ${table} — CRM state is owned by the user`
          );
        },

        delete() {
          throw new Error(`fake db: syncLeads must never DELETE from ${table}`);
        }
      };

      return builder;
    };

    return { from } as unknown as CrmSupabaseClient;
  }
}

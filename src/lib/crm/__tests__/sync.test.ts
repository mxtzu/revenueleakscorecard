import { describe, expect, it } from 'vitest';

import {
  formatSyncResult,
  isImportable,
  parseExportDocument,
  syncLeads,
  toIntelligenceRow,
  type PipelineLeadExport
} from '../sync';
import { FakeDb } from './fakeSupabase';

function lead(overrides: Partial<PipelineLeadExport> = {}): PipelineLeadExport {
  return {
    lead_id: 'abc123',
    company_name: 'Riverside Dental Studio',
    niche: 'invisalign_dental_practices',
    website: 'https://riversidedentalstudio.co.uk',
    domain: 'riversidedentalstudio.co.uk',
    business_phone: '+441915550101',
    city: 'Newcastle upon Tyne',
    lead_score: 72,
    online_presence: { facebook_url: 'https://facebook.com/riverside' },
    google: { google_rating: 4.8, google_review_count: 237, google_place_id: 'ChIJtest0001' },
    advertising_analysis: { status: 'likely' },
    score: { total: 72, band: 'strong' },
    opportunities: ['No conversion tracking detected'],
    sources: ['google_places'],
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------
describe('parseExportDocument', () => {
  it('accepts the pipeline export envelope', () => {
    const leads = parseExportDocument({ generated_at: 'now', lead_count: 1, leads: [lead()] });
    expect(leads).toHaveLength(1);
  });

  it('accepts a bare array', () => {
    expect(parseExportDocument([lead()])).toHaveLength(1);
  });

  it('rejects anything else with an actionable message', () => {
    expect(() => parseExportDocument({ rows: [] })).toThrow(/leads.*array/i);
    expect(() => parseExportDocument('nope')).toThrow(/Unrecognised export/);
  });
});

describe('isImportable', () => {
  it('requires the stable id and a name', () => {
    expect(isImportable(lead())).toBe(true);
    expect(isImportable(lead({ lead_id: '' }))).toBe(false);
    expect(isImportable(lead({ company_name: '   ' }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------
describe('toIntelligenceRow', () => {
  it('flattens the nested export into the table shape', () => {
    const row = toIntelligenceRow(lead(), '2026-08-16T00:00:00.000Z');

    expect(row.external_lead_id).toBe('abc123');
    expect(row.facebook_url).toBe('https://facebook.com/riverside');
    expect(row.google_rating).toBe(4.8);
    expect(row.google_place_id).toBe('ChIJtest0001');
    expect(row.advertising_status).toBe('likely');
    expect(row.score_band).toBe('strong');
    expect(row.synced_at).toBe('2026-08-16T00:00:00.000Z');
  });

  it('keeps a missing google_maps_url null rather than borrowing another field', () => {
    const row = toIntelligenceRow(lead());
    expect(row.google_maps_url).toBeNull();

    const withUrl = toIntelligenceRow(
      lead({ online_presence: { google_maps_url: 'https://maps.google.com/?cid=1' } })
    );
    expect(withUrl.google_maps_url).toBe('https://maps.google.com/?cid=1');
  });

  it('carries the published contact through with its role and source', () => {
    const row = toIntelligenceRow(
      lead({
        contact_name: 'Helen Carter',
        contact_role: 'Managing Director',
        contact_source_url: 'https://riverside.co.uk/meet-the-team'
      })
    );
    expect(row.contact_name).toBe('Helen Carter');
    expect(row.contact_role).toBe('Managing Director');
    expect(row.contact_source_url).toBe('https://riverside.co.uk/meet-the-team');
  });

  it('leaves the contact null when the pipeline named nobody', () => {
    const row = toIntelligenceRow(lead());
    expect(row.contact_name).toBeNull();
    expect(row.contact_role).toBeNull();
    expect(row.contact_source_url).toBeNull();
  });

  it('falls back to score.total when lead_score is absent', () => {
    const row = toIntelligenceRow(lead({ lead_score: null, score: { total: 61, band: 'good' } }));
    expect(row.lead_score).toBe(61);
  });

  it('represents unknown values as null, never as zero or an empty string', () => {
    const row = toIntelligenceRow({ lead_id: 'x', company_name: 'Bare Ltd' });

    expect(row.website).toBeNull();
    expect(row.business_phone).toBeNull();
    expect(row.google_rating).toBeNull();
    expect(row.lead_score).toBeNull();
    expect(row.advertising_status).toBeNull();
    // Array/jsonb columns are NOT NULL in the schema, so they default to empty.
    expect(row.opportunities).toEqual([]);
    expect(row.emails).toEqual([]);
  });

  it('drops a malformed incorporation date instead of passing it to a date column', () => {
    expect(
      toIntelligenceRow(lead({ company_registry: { incorporation_date: 'unknown' } }))
        .incorporation_date
    ).toBeNull();
    expect(
      toIntelligenceRow(lead({ company_registry: { incorporation_date: '2014-03-09' } }))
        .incorporation_date
    ).toBe('2014-03-09');
  });

  it('trims whitespace-only strings to null', () => {
    const row = toIntelligenceRow(lead({ business_email: '   ', trading_name: '  Riverside  ' }));
    expect(row.business_email).toBeNull();
    expect(row.trading_name).toBe('Riverside');
  });
});

// ---------------------------------------------------------------------------
// Sync behaviour
// ---------------------------------------------------------------------------
describe('syncLeads', () => {
  it('creates a crm_leads row and its intelligence on first import', async () => {
    const db = new FakeDb();
    const result = await syncLeads(db.client(), [lead()]);

    expect(result.crmLeadsCreated).toBe(1);
    expect(result.crmLeadsExisting).toBe(0);
    expect(result.intelligenceUpserted).toBe(1);
    expect(db.leads).toHaveLength(1);
    expect(db.leads[0].pipeline_stage).toBe('qualified');
    expect(db.intelligence[0].crm_lead_id).toBe(db.leads[0].id);
  });

  it('is idempotent: importing the same export twice creates no duplicate', async () => {
    const db = new FakeDb();
    const payload = [lead(), lead({ lead_id: 'def456', company_name: 'Northern Aesthetics' })];

    const first = await syncLeads(db.client(), payload);
    const second = await syncLeads(db.client(), payload);

    expect(first.crmLeadsCreated).toBe(2);
    expect(second.crmLeadsCreated).toBe(0);
    expect(second.crmLeadsExisting).toBe(2);
    expect(db.leads).toHaveLength(2);
    expect(db.intelligence).toHaveLength(2);
  });

  it('never overwrites CRM state on re-sync', async () => {
    const db = new FakeDb();
    // A lead the team has already worked and won.
    db.seedLead('abc123', {
      pipeline_stage: 'won',
      owner_id: 'user-1',
      next_action: 'Kickoff call'
    });

    const result = await syncLeads(db.client(), [lead({ company_name: 'Renamed Dental' })]);

    expect(result.crmLeadsCreated).toBe(0);
    expect(db.leads[0].pipeline_stage).toBe('won');
    expect(db.leads[0].owner_id).toBe('user-1');
    expect(db.leads[0].next_action).toBe('Kickoff call');
    // The refreshed research still lands.
    expect(db.intelligence[0].company_name).toBe('Renamed Dental');
  });

  it('writes to lead_intelligence only, never to any other CRM table', async () => {
    const db = new FakeDb();
    db.seedLead('abc123', { pipeline_stage: 'proposal' });

    await syncLeads(db.client(), [lead()]);

    expect(db.writes).toEqual(['lead_intelligence']);
  });

  it('applies initialStage to new leads without touching existing ones', async () => {
    const db = new FakeDb();
    db.seedLead('abc123', { pipeline_stage: 'negotiation' });

    await syncLeads(db.client(), [lead(), lead({ lead_id: 'new1', company_name: 'Fresh Ltd' })], {
      initialStage: 'ready_for_outreach'
    });

    expect(db.leads.find((row) => row.external_lead_id === 'abc123')?.pipeline_stage).toBe(
      'negotiation'
    );
    expect(db.leads.find((row) => row.external_lead_id === 'new1')?.pipeline_stage).toBe(
      'ready_for_outreach'
    );
  });

  it('skips leads below minScore and counts them', async () => {
    const db = new FakeDb();
    const result = await syncLeads(
      db.client(),
      [lead({ lead_score: 72 }), lead({ lead_id: 'weak', lead_score: 12 })],
      { minScore: 50 }
    );

    expect(result.skippedBelowMinScore).toBe(1);
    expect(result.crmLeadsCreated).toBe(1);
    expect(db.leads).toHaveLength(1);
  });

  it('skips unidentifiable leads rather than inventing an id', async () => {
    const db = new FakeDb();
    const result = await syncLeads(db.client(), [
      lead(),
      { lead_id: '', company_name: 'Nameless' } as PipelineLeadExport
    ]);

    expect(result.skippedInvalid).toBe(1);
    expect(db.leads).toHaveLength(1);
  });

  it('collapses a lead that appears twice in one payload', async () => {
    const db = new FakeDb();
    const result = await syncLeads(db.client(), [
      lead({ city: 'Newcastle upon Tyne' }),
      lead({ city: 'Gateshead' })
    ]);

    expect(result.received).toBe(2);
    expect(result.crmLeadsCreated).toBe(1);
    expect(db.leads).toHaveLength(1);
    // Last occurrence wins, deterministically.
    expect(db.intelligence[0].city).toBe('Gateshead');
  });

  it('survives losing an insert race to a concurrent sync', async () => {
    // Another process inserts the same lead between our SELECT and our INSERT.
    const db = new FakeDb({
      beforeLeadInsert: (store) => {
        if (!store.leads.length) store.seedLead('abc123', { pipeline_stage: 'contacted' });
      }
    });

    const result = await syncLeads(db.client(), [lead()]);

    expect(result.errors).toEqual([]);
    expect(db.leads).toHaveLength(1);
    // The winner's row is intact — we did not clobber it back to 'qualified'.
    expect(db.leads[0].pipeline_stage).toBe('contacted');
    expect(result.intelligenceUpserted).toBe(1);
  });

  it('reports an intelligence failure instead of claiming success', async () => {
    const db = new FakeDb({ intelligenceError: 'permission denied for table lead_intelligence' });
    const result = await syncLeads(db.client(), [lead()]);

    expect(result.crmLeadsCreated).toBe(1);
    expect(result.intelligenceUpserted).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/permission denied/);
  });

  it('does nothing at all for an empty payload', async () => {
    const db = new FakeDb();
    const result = await syncLeads(db.client(), []);

    expect(result).toMatchObject({ received: 0, crmLeadsCreated: 0, intelligenceUpserted: 0 });
    expect(db.writes).toEqual([]);
  });

  it('batches large payloads without dropping rows', async () => {
    const db = new FakeDb();
    const many = Array.from({ length: 450 }, (_, index) =>
      lead({ lead_id: `lead-${index}`, company_name: `Business ${index}` })
    );

    const result = await syncLeads(db.client(), many, { batchSize: 100 });

    expect(result.crmLeadsCreated).toBe(450);
    expect(db.leads).toHaveLength(450);
    expect(db.intelligence).toHaveLength(450);
  });
});

describe('formatSyncResult', () => {
  it('states preservation explicitly so a re-run is not mistaken for a no-op', () => {
    const text = formatSyncResult({
      received: 3,
      skippedBelowMinScore: 1,
      skippedInvalid: 0,
      crmLeadsCreated: 0,
      crmLeadsExisting: 2,
      intelligenceUpserted: 2,
      errors: []
    });

    expect(text).toContain('Already in CRM:      2 (stage and history preserved)');
    expect(text).toContain('Skipped (min score): 1');
    expect(text).not.toContain('Skipped (invalid)');
  });
});

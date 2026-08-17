import { describe, expect, it } from 'vitest';

import {
  getPipelineCounts,
  listClients,
  listLeads,
  listOpenTasks,
  listPaymentsForClient,
  listUpcomingAppointments,
  setPipelineStage
} from '../queries';
import { RecordingClient, failingClient } from './recordingClient';

describe('listLeads filters', () => {
  it('filters on the embed alias, not the table name', async () => {
    // The bug: PostgREST resolves embedded filters by the name used in the
    // select. `lead_intelligence.company_name` does not exist once the embed is
    // aliased `intelligence`, so the request errored and the page 500'd.
    const recorder = new RecordingClient();
    await listLeads(recorder.client(), { search: 'Riverside' });

    const columns = recorder.last.filters.map((filter) => filter.column);
    expect(columns).toContain('intelligence.company_name');
    expect(columns.some((column) => column.startsWith('lead_intelligence.'))).toBe(false);
  });

  it('inner-joins the embed whenever a filter depends on it', async () => {
    // Without !inner, PostgREST filters the embed and returns every parent row
    // regardless — a search would hand back the entire list.
    for (const filters of [
      { search: 'Riverside' },
      { niche: 'cosmetic_dentists' },
      { minScore: 60 }
    ]) {
      const recorder = new RecordingClient();
      await listLeads(recorder.client(), filters);
      expect(recorder.last.select).toContain('lead_intelligence!inner');
    }
  });

  it('does not inner-join when nothing needs it', async () => {
    // An inner join on an unfiltered list would silently hide any lead whose
    // first sync has not run yet.
    const recorder = new RecordingClient();
    await listLeads(recorder.client(), { stage: 'qualified' });

    expect(recorder.last.select).toContain('lead_intelligence(*)');
    expect(recorder.last.select).not.toContain('!inner');
  });

  it('filters stage and owner on crm_leads itself', async () => {
    const recorder = new RecordingClient();
    await listLeads(recorder.client(), { stage: 'proposal', ownerId: 'user-1' });

    expect(recorder.last.filters).toEqual([
      { op: 'eq', column: 'pipeline_stage', value: 'proposal' },
      { op: 'eq', column: 'owner_id', value: 'user-1' }
    ]);
  });

  it('strips PostgREST metacharacters out of a search term', async () => {
    // An unescaped % or , changes the meaning of the filter rather than
    // matching literally.
    const recorder = new RecordingClient();
    await listLeads(recorder.client(), { search: '100%,dental(x)' });

    const search = recorder.embeddedFilters('intelligence')[0];
    expect(search.value).toBe('%100 dental x%');
  });

  it('treats a search of only metacharacters as no search at all', async () => {
    const recorder = new RecordingClient();
    await listLeads(recorder.client(), { search: '%%%' });

    expect(recorder.embeddedFilters('intelligence')).toHaveLength(0);
    expect(recorder.last.select).not.toContain('!inner');
  });

  it('applies minScore of zero rather than dropping it as falsy', async () => {
    const recorder = new RecordingClient();
    await listLeads(recorder.client(), { minScore: 0 });

    expect(recorder.last.filters).toContainEqual({
      op: 'gte',
      column: 'intelligence.lead_score',
      value: 0
    });
  });

  it('orders by most recently updated and caps the result', async () => {
    const recorder = new RecordingClient();
    await listLeads(recorder.client(), { limit: 25 });

    expect(recorder.last.order).toEqual([{ column: 'updated_at', ascending: false }]);
    expect(recorder.last.limit).toBe(25);
  });
});

describe('other queries build the request they claim to', () => {
  it('listOpenTasks asks only for unfinished work', async () => {
    const recorder = new RecordingClient();
    await listOpenTasks(recorder.client());

    expect(recorder.last.filters).toContainEqual({
      op: 'in',
      column: 'status',
      value: ['pending', 'in_progress']
    });
  });

  it('listUpcomingAppointments excludes cancelled and no-shows', async () => {
    const recorder = new RecordingClient();
    await listUpcomingAppointments(recorder.client());

    const ops = recorder.last.filters.map((filter) => filter.op);
    expect(ops).toContain('gte'); // starts_at >= now
    expect(ops).toContain('not.in'); // status not in (cancelled, no_show)
  });

  it('listPaymentsForClient scopes to one client', async () => {
    const recorder = new RecordingClient();
    await listPaymentsForClient(recorder.client(), 'client-1');

    expect(recorder.last.table).toBe('payments');
    expect(recorder.last.filters).toContainEqual({
      op: 'eq',
      column: 'client_id',
      value: 'client-1'
    });
  });

  it('setPipelineStage writes only the stage and its matching reason column', async () => {
    const recorder = new RecordingClient([{ id: 'lead-1' }]);
    await setPipelineStage(recorder.client(), 'lead-1', 'lost', { loss_reason: 'Went in-house' });

    expect(recorder.last.table).toBe('crm_leads');
    expect(recorder.last.filters).toContainEqual({ op: 'eq', column: 'id', value: 'lead-1' });
  });

  it('getPipelineCounts tallies stages without a round trip per stage', async () => {
    const recorder = new RecordingClient([
      { pipeline_stage: 'qualified' },
      { pipeline_stage: 'qualified' },
      { pipeline_stage: 'won' }
    ]);

    expect(await getPipelineCounts(recorder.client())).toEqual({ qualified: 2, won: 1 });
    expect(recorder.queries).toHaveLength(1);
  });
});

describe('read failures surface instead of rendering an empty page', () => {
  it('throws with the query name and the database message', async () => {
    const client = failingClient('permission denied for table crm_leads');

    await expect(listLeads(client)).rejects.toThrow(/listLeads/);
    await expect(listLeads(client)).rejects.toThrow(/permission denied/);
  });

  it('applies to every list query, not just leads', async () => {
    const client = failingClient('connection reset');
    await expect(listClients(client)).rejects.toThrow(/listClients/);
    await expect(listOpenTasks(client)).rejects.toThrow(/listOpenTasks/);
  });
});

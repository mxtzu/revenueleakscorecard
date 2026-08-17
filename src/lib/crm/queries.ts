/**
 * CRM read/write helpers.
 *
 * Every function takes an explicit client so the caller decides whether the
 * query runs under the user's session (RLS enforced) or the service role.
 * Reads throw on error rather than returning empty, so a broken policy shows
 * up as a visible failure instead of a silently empty screen.
 */

import type {
  Activity,
  Appointment,
  Client,
  Contact,
  Contract,
  CrmDocument,
  CrmLead,
  CrmLeadWithIntelligence,
  LeadDetail,
  LeadIntelligence,
  Opportunity,
  LeadOutreach,
  Note,
  OutreachSequence,
  OutreachStep,
  Payment,
  Proposal,
  PipelineStage,
  PipelineStageHistoryEntry,
  Profile,
  Task
} from './types';
import type { CrmSupabaseClient } from './supabase';

function unwrap<T>(result: { data: T | null; error: { message: string } | null }, what: string): T {
  if (result.error) {
    throw new Error(`CRM query failed (${what}): ${result.error.message}`);
  }
  return (result.data ?? []) as T;
}

// ---------------------------------------------------------------------------
// Leads
// ---------------------------------------------------------------------------
export interface LeadListFilters {
  stage?: PipelineStage;
  ownerId?: string;
  niche?: string;
  minScore?: number;
  search?: string;
  limit?: number;
}

/**
 * The embed is aliased `intelligence`, and PostgREST resolves embedded filters
 * by the name used in the select — so filters must say `intelligence.niche`,
 * never `lead_intelligence.niche`.
 *
 * `!inner` matters just as much. Filtering an embedded resource without it
 * filters the *embed* and returns every parent row regardless, with the embed
 * emptied: a search for "Riverside" would hand back all 200 leads, most of them
 * showing a raw id instead of a company name. The inner join is what makes the
 * filter apply to the lead.
 *
 * The join is only requested when a filter needs it. An inner join would
 * otherwise silently drop leads that have no intelligence row yet — a lead
 * created before its first sync would vanish from an unfiltered list.
 */
const OWNER_EMBED = 'owner:profiles!crm_leads_owner_id_fkey(id, full_name, email)';

/**
 * Written out in full rather than composed at runtime: supabase-js parses the
 * select string at the type level, and a `string` it cannot read collapses the
 * row type to an error placeholder.
 */
const LEAD_SELECT = `*, intelligence:lead_intelligence(*), ${OWNER_EMBED}` as const;
const LEAD_SELECT_INNER = `*, intelligence:lead_intelligence!inner(*), ${OWNER_EMBED}` as const;

/**
 * PostgREST treats these as reserved inside a filter value, so they are
 * replaced rather than escaped — a user typing "100%" wants a literal search,
 * not a wildcard. Runs of whitespace collapse so the replacement does not leave
 * a term that matches nothing.
 */
function escapeLike(value: string): string {
  return value.replace(/[%_,()]/g, ' ').replace(/\s+/g, ' ').trim();
}

export async function listLeads(
  client: CrmSupabaseClient,
  filters: LeadListFilters = {}
): Promise<CrmLeadWithIntelligence[]> {
  const search = filters.search ? escapeLike(filters.search) : '';
  const needsIntelligence = Boolean(filters.niche || filters.minScore !== undefined || search);

  let query = client
    .from('crm_leads')
    .select(needsIntelligence ? LEAD_SELECT_INNER : LEAD_SELECT);

  if (filters.stage) query = query.eq('pipeline_stage', filters.stage);
  if (filters.ownerId) query = query.eq('owner_id', filters.ownerId);
  if (filters.niche) query = query.eq('intelligence.niche', filters.niche);
  if (filters.minScore !== undefined) {
    query = query.gte('intelligence.lead_score', filters.minScore);
  }
  if (search) {
    query = query.ilike('intelligence.company_name', `%${search}%`);
  }

  const result = await query
    .order('updated_at', { ascending: false })
    .limit(filters.limit ?? 100);

  const rows = unwrap<Record<string, unknown>[]>(result, 'listLeads');
  return rows.map(normaliseLeadRow);
}

/**
 * PostgREST returns a 1:1 embed as either an object or a single-element array
 * depending on how the relationship is inferred; normalise to an object.
 */
function normaliseLeadRow(row: Record<string, unknown>): CrmLeadWithIntelligence {
  const intelligence = row.intelligence;
  const owner = row.owner;
  return {
    ...(row as unknown as CrmLead),
    intelligence: (Array.isArray(intelligence) ? intelligence[0] : intelligence) as
      | LeadIntelligence
      | null,
    owner: (Array.isArray(owner) ? owner[0] : owner) as CrmLeadWithIntelligence['owner']
  };
}

export async function getLeadById(
  client: CrmSupabaseClient,
  id: string
): Promise<CrmLeadWithIntelligence | null> {
  const result = await client
    .from('crm_leads')
    .select(LEAD_SELECT)
    .eq('id', id)
    .maybeSingle();

  if (result.error) throw new Error(`CRM query failed (getLeadById): ${result.error.message}`);
  return result.data ? normaliseLeadRow(result.data as Record<string, unknown>) : null;
}

export async function getLeadByExternalId(
  client: CrmSupabaseClient,
  externalLeadId: string
): Promise<CrmLeadWithIntelligence | null> {
  const result = await client
    .from('crm_leads')
    .select(LEAD_SELECT)
    .eq('external_lead_id', externalLeadId)
    .maybeSingle();

  if (result.error) {
    throw new Error(`CRM query failed (getLeadByExternalId): ${result.error.message}`);
  }
  return result.data ? normaliseLeadRow(result.data as Record<string, unknown>) : null;
}

/** Everything the lead detail page renders, fetched in parallel. */
export async function getLeadDetail(
  client: CrmSupabaseClient,
  id: string
): Promise<LeadDetail | null> {
  const lead = await getLeadById(client, id);
  if (!lead) return null;

  const [contacts, activities, tasks, appointments, opportunities, stageHistory, notes] =
    await Promise.all([
      listContacts(client, id),
      listActivities(client, id),
      listTasksForLead(client, id),
      listAppointmentsForLead(client, id),
      listOpportunitiesForLead(client, id),
      listStageHistory(client, id),
      listNotesForLead(client, id)
    ]);

  return { ...lead, contacts, activities, tasks, appointments, opportunities, stageHistory, notes };
}

/** Counts per stage, for the pipeline board. */
export async function getPipelineCounts(
  client: CrmSupabaseClient
): Promise<Record<string, number>> {
  const result = await client.from('crm_leads').select('pipeline_stage');
  const rows = unwrap<{ pipeline_stage: PipelineStage }[]>(result, 'getPipelineCounts');
  return rows.reduce<Record<string, number>>((counts, row) => {
    counts[row.pipeline_stage] = (counts[row.pipeline_stage] ?? 0) + 1;
    return counts;
  }, {});
}

/**
 * Move a lead to a new stage. The history row and the funnel timestamps are
 * written by database triggers, so callers cannot forget them.
 */
export async function setPipelineStage(
  client: CrmSupabaseClient,
  id: string,
  stage: PipelineStage,
  extra: Partial<Pick<CrmLead, 'loss_reason' | 'disqualification_reason' | 'next_action' | 'next_action_at'>> = {}
): Promise<CrmLead> {
  const result = await client
    .from('crm_leads')
    .update({ pipeline_stage: stage, ...extra })
    .eq('id', id)
    .select()
    .single();

  if (result.error) throw new Error(`CRM update failed (setPipelineStage): ${result.error.message}`);
  return result.data as CrmLead;
}

// ---------------------------------------------------------------------------
// Contacts / activities / tasks / appointments / opportunities
// ---------------------------------------------------------------------------
export async function listContacts(client: CrmSupabaseClient, leadId: string): Promise<Contact[]> {
  const result = await client
    .from('contacts')
    .select('*')
    .eq('crm_lead_id', leadId)
    .order('is_primary', { ascending: false })
    .order('created_at', { ascending: true });
  return unwrap<Contact[]>(result, 'listContacts');
}

export async function listActivities(
  client: CrmSupabaseClient,
  leadId: string,
  limit = 100
): Promise<Activity[]> {
  const result = await client
    .from('activities')
    .select('*')
    .eq('crm_lead_id', leadId)
    .order('occurred_at', { ascending: false })
    .limit(limit);
  return unwrap<Activity[]>(result, 'listActivities');
}

/**
 * Record a communication event.
 *
 * An inbound reply additionally halts any running outreach sequence and moves
 * the lead to `replied` — that happens in a database trigger, so it holds
 * however the activity was created.
 */
export async function recordActivity(
  client: CrmSupabaseClient,
  activity: Omit<Activity, 'id' | 'created_at' | 'occurred_at' | 'metadata'> &
    Partial<Pick<Activity, 'occurred_at' | 'metadata'>>
): Promise<Activity> {
  const result = await client.from('activities').insert(activity).select().single();
  if (result.error) throw new Error(`CRM insert failed (recordActivity): ${result.error.message}`);
  return result.data as Activity;
}

export async function listTasksForLead(client: CrmSupabaseClient, leadId: string): Promise<Task[]> {
  const result = await client
    .from('tasks')
    .select('*')
    .eq('crm_lead_id', leadId)
    .order('due_at', { ascending: true, nullsFirst: false });
  return unwrap<Task[]>(result, 'listTasksForLead');
}

/** Open tasks due on or before the end of today — the "today" list. */
export async function listTodaysTasks(
  client: CrmSupabaseClient,
  assignedTo?: string
): Promise<Task[]> {
  const endOfToday = new Date();
  endOfToday.setHours(23, 59, 59, 999);

  let query = client
    .from('tasks')
    .select('*')
    .in('status', ['pending', 'in_progress'])
    .lte('due_at', endOfToday.toISOString())
    .order('due_at', { ascending: true });

  if (assignedTo) query = query.eq('assigned_to', assignedTo);
  return unwrap<Task[]>(await query, 'listTodaysTasks');
}

export async function listOpenTasks(client: CrmSupabaseClient, limit = 200): Promise<Task[]> {
  const result = await client
    .from('tasks')
    .select('*')
    .in('status', ['pending', 'in_progress'])
    .order('due_at', { ascending: true, nullsFirst: false })
    .limit(limit);
  return unwrap<Task[]>(result, 'listOpenTasks');
}

export async function listAppointmentsForLead(
  client: CrmSupabaseClient,
  leadId: string
): Promise<Appointment[]> {
  const result = await client
    .from('appointments')
    .select('*')
    .eq('crm_lead_id', leadId)
    .order('starts_at', { ascending: false });
  return unwrap<Appointment[]>(result, 'listAppointmentsForLead');
}

export async function listUpcomingAppointments(
  client: CrmSupabaseClient,
  limit = 50
): Promise<Appointment[]> {
  const result = await client
    .from('appointments')
    .select('*')
    .gte('starts_at', new Date().toISOString())
    .not('status', 'in', '("cancelled","no_show")')
    .order('starts_at', { ascending: true })
    .limit(limit);
  return unwrap<Appointment[]>(result, 'listUpcomingAppointments');
}

export async function listOpportunitiesForLead(
  client: CrmSupabaseClient,
  leadId: string
): Promise<Opportunity[]> {
  const result = await client
    .from('opportunities')
    .select('*')
    .eq('crm_lead_id', leadId)
    .order('created_at', { ascending: false });
  return unwrap<Opportunity[]>(result, 'listOpportunitiesForLead');
}

export async function listOpportunities(
  client: CrmSupabaseClient,
  limit = 200
): Promise<Opportunity[]> {
  const result = await client
    .from('opportunities')
    .select('*')
    .order('expected_close_date', { ascending: true, nullsFirst: false })
    .limit(limit);
  return unwrap<Opportunity[]>(result, 'listOpportunities');
}

export async function listStageHistory(
  client: CrmSupabaseClient,
  leadId: string
): Promise<PipelineStageHistoryEntry[]> {
  const result = await client
    .from('pipeline_stage_history')
    .select('*')
    .eq('crm_lead_id', leadId)
    .order('created_at', { ascending: false });
  return unwrap<PipelineStageHistoryEntry[]>(result, 'listStageHistory');
}

// ---------------------------------------------------------------------------
// Clients and payments
// ---------------------------------------------------------------------------
export async function listClients(client: CrmSupabaseClient): Promise<Client[]> {
  const result = await client
    .from('clients')
    .select('*')
    .order('created_at', { ascending: false });
  return unwrap<Client[]>(result, 'listClients');
}

export async function getClientById(
  client: CrmSupabaseClient,
  id: string
): Promise<Client | null> {
  const result = await client.from('clients').select('*').eq('id', id).maybeSingle();
  if (result.error) throw new Error(`CRM query failed (getClientById): ${result.error.message}`);
  return (result.data as Client) ?? null;
}

export async function listPayments(client: CrmSupabaseClient, limit = 200): Promise<Payment[]> {
  const result = await client
    .from('payments')
    .select('*')
    .order('due_at', { ascending: true, nullsFirst: false })
    .limit(limit);
  return unwrap<Payment[]>(result, 'listPayments');
}

export async function listPaymentsForClient(
  client: CrmSupabaseClient,
  clientId: string
): Promise<Payment[]> {
  const result = await client
    .from('payments')
    .select('*')
    .eq('client_id', clientId)
    .order('due_at', { ascending: false, nullsFirst: false });
  return unwrap<Payment[]>(result, 'listPaymentsForClient');
}

export async function listContractsForClient(
  client: CrmSupabaseClient,
  clientId: string
): Promise<Contract[]> {
  const result = await client
    .from('contracts')
    .select('*')
    .eq('client_id', clientId)
    .order('start_date', { ascending: false, nullsFirst: false });
  return unwrap<Contract[]>(result, 'listContractsForClient');
}

export async function listActivitiesForClient(
  client: CrmSupabaseClient,
  clientId: string,
  limit = 50
): Promise<Activity[]> {
  const result = await client
    .from('activities')
    .select('*')
    .eq('client_id', clientId)
    .order('occurred_at', { ascending: false })
    .limit(limit);
  return unwrap<Activity[]>(result, 'listActivitiesForClient');
}

// ---------------------------------------------------------------------------
// Proposals, contracts, documents
// ---------------------------------------------------------------------------
export async function listProposalsForOpportunity(
  client: CrmSupabaseClient,
  opportunityId: string
): Promise<Proposal[]> {
  const result = await client
    .from('proposals')
    .select('*')
    .eq('opportunity_id', opportunityId)
    .order('version', { ascending: false });
  return unwrap<Proposal[]>(result, 'listProposalsForOpportunity');
}

/** Every proposal across the pipeline, newest first. */
export async function listProposals(
  client: CrmSupabaseClient,
  limit = 200
): Promise<Proposal[]> {
  const result = await client
    .from('proposals')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  return unwrap<Proposal[]>(result, 'listProposals');
}

export async function listDocumentsForLead(
  client: CrmSupabaseClient,
  leadId: string
): Promise<CrmDocument[]> {
  const result = await client
    .from('documents')
    .select('*')
    .eq('crm_lead_id', leadId)
    .order('created_at', { ascending: false });
  return unwrap<CrmDocument[]>(result, 'listDocumentsForLead');
}

export async function listDocumentsForClient(
  client: CrmSupabaseClient,
  clientId: string
): Promise<CrmDocument[]> {
  const result = await client
    .from('documents')
    .select('*')
    .eq('client_id', clientId)
    .order('created_at', { ascending: false });
  return unwrap<CrmDocument[]>(result, 'listDocumentsForClient');
}

export async function getDocumentById(
  client: CrmSupabaseClient,
  id: string
): Promise<CrmDocument | null> {
  const result = await client.from('documents').select('*').eq('id', id).maybeSingle();
  if (result.error) throw new Error(`CRM query failed (getDocumentById): ${result.error.message}`);
  return (result.data as CrmDocument) ?? null;
}

// ---------------------------------------------------------------------------
// Outreach
// ---------------------------------------------------------------------------
export async function listOutreachSequences(
  client: CrmSupabaseClient
): Promise<OutreachSequence[]> {
  const result = await client
    .from('outreach_sequences')
    .select('*')
    .order('created_at', { ascending: true });
  return unwrap<OutreachSequence[]>(result, 'listOutreachSequences');
}

export async function listOutreachSteps(
  client: CrmSupabaseClient,
  sequenceId?: string
): Promise<OutreachStep[]> {
  let query = client.from('outreach_steps').select('*');
  if (sequenceId) query = query.eq('sequence_id', sequenceId);
  const result = await query.order('step_number', { ascending: true });
  return unwrap<OutreachStep[]>(result, 'listOutreachSteps');
}

/**
 * Enrolment rows for one lead.
 *
 * Nothing in the CRM enrols a lead — the outreach engine is deliberately not
 * built. The rows exist because `halt_outreach_on_inbound_reply` writes to them,
 * and because an external runner may. Showing them read-only means state that
 * something else changed is at least visible.
 */
export async function listOutreachForLead(
  client: CrmSupabaseClient,
  leadId: string
): Promise<LeadOutreach[]> {
  const result = await client
    .from('lead_outreach')
    .select('*')
    .eq('crm_lead_id', leadId)
    .order('created_at', { ascending: false });
  return unwrap<LeadOutreach[]>(result, 'listOutreachForLead');
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------
export async function listNotesForLead(
  client: CrmSupabaseClient,
  leadId: string
): Promise<Note[]> {
  const result = await client
    .from('notes')
    .select('*')
    .eq('crm_lead_id', leadId)
    .order('created_at', { ascending: false });
  return unwrap<Note[]>(result, 'listNotesForLead');
}

export async function listNotesForClient(
  client: CrmSupabaseClient,
  clientId: string
): Promise<Note[]> {
  const result = await client
    .from('notes')
    .select('*')
    .eq('client_id', clientId)
    .order('created_at', { ascending: false });
  return unwrap<Note[]>(result, 'listNotesForClient');
}

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------
/** Active team members, for owner and assignee pickers. */
export async function listAssignableProfiles(client: CrmSupabaseClient): Promise<Profile[]> {
  const result = await client
    .from('profiles')
    .select('*')
    .eq('is_active', true)
    .order('full_name', { ascending: true, nullsFirst: false });
  return unwrap<Profile[]>(result, 'listAssignableProfiles');
}

export async function getCurrentProfile(client: CrmSupabaseClient): Promise<Profile | null> {
  const { data: auth } = await client.auth.getUser();
  if (!auth?.user) return null;

  const result = await client.from('profiles').select('*').eq('id', auth.user.id).maybeSingle();
  if (result.error) return null;
  return (result.data as Profile) ?? null;
}

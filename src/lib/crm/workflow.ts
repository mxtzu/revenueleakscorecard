/**
 * The sales workflow: the four transitions that move a deal through the
 * pipeline, plus call logging.
 *
 * Unlike `mutations.ts`, none of these is a single-table write. Converting a
 * lead touches `opportunities`, `crm_leads` and `activities`; winning one also
 * creates a `clients` row and possibly a `contracts` row. PostgREST cannot
 * send a transaction, so four sequential REST calls can fail halfway and leave
 * a won opportunity with no client, or a client whose lead is still sitting in
 * `sales_call`.
 *
 * Each function here is therefore one `rpc()` call into a plpgsql function
 * from `20260818_sales_workflow.sql`, which does the whole transition in one
 * transaction. Those functions are SECURITY INVOKER, so RLS still decides what
 * the caller may write — the transaction buys atomicity, not privilege.
 *
 * The argument names must match the SQL parameter names exactly. Postgres
 * resolves named arguments by name, so a typo here is a "function does not
 * exist" at runtime rather than a compile error; the input types below exist
 * to keep the two in step, and the RPC tests assert the payload shape.
 */

import type { CrmSupabaseClient } from './supabase';
import type {
  ClientStatus,
  ContractStatus,
  OpportunityStage,
  PipelineStage
} from './types';

/** Pipeline stages a lost deal may close its lead into. */
export const LEAD_CLOSE_STAGES = ['lost', 'disqualified', 'do_not_contact'] as const;
export type LeadCloseStage = (typeof LEAD_CLOSE_STAGES)[number];

function unwrapRpc<T>(
  result: { data: T | null; error: { message: string } | null },
  what: string
): T {
  // The Postgres function raises with a sentence written to be read, so the
  // message is passed through rather than replaced with a generic one.
  if (result.error) throw new Error(result.error.message || what);
  if (result.data === null || result.data === undefined) {
    throw new Error(`${what}: the database returned nothing.`);
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// Lead → Opportunity
// ---------------------------------------------------------------------------
export interface ConvertLeadInput {
  crm_lead_id: string;
  name: string;
  stage: OpportunityStage;
  contact_id: string | null;
  owner_id: string | null;
  service_name: string | null;
  setup_fee: number | null;
  monthly_value: number | null;
  one_time_value: number | null;
  contract_months: number | null;
  probability: number | null;
  expected_close_date: string | null;
  pain_points: string | null;
  desired_outcome: string | null;
  budget: string | null;
  objections: string | null;
  next_action: string | null;
  next_action_at: string | null;
  note: string | null;
}

/** Returns the id of the new opportunity. */
export async function convertLeadToOpportunity(
  client: CrmSupabaseClient,
  input: ConvertLeadInput
): Promise<string> {
  const result = await client.rpc('crm_convert_lead_to_opportunity', {
    p_lead_id: input.crm_lead_id,
    p_name: input.name,
    p_stage: input.stage,
    p_contact_id: input.contact_id,
    p_owner_id: input.owner_id,
    p_service_name: input.service_name,
    p_setup_fee: input.setup_fee,
    p_monthly_value: input.monthly_value,
    p_one_time_value: input.one_time_value,
    p_contract_months: input.contract_months,
    p_probability: input.probability,
    p_expected_close_date: input.expected_close_date,
    p_pain_points: input.pain_points,
    p_desired_outcome: input.desired_outcome,
    p_budget: input.budget,
    p_objections: input.objections,
    p_next_action: input.next_action,
    p_next_action_at: input.next_action_at,
    p_note: input.note
  });
  return unwrapRpc<string>(result, 'Could not open the opportunity');
}

// ---------------------------------------------------------------------------
// Proposal sent
// ---------------------------------------------------------------------------

/**
 * Records that a proposal went out, and pulls the deal and lead up to match.
 *
 * Nothing is sent. The document is delivered by a person, out of band; this is
 * the CRM catching up with what they did.
 */
export async function markProposalSent(
  client: CrmSupabaseClient,
  proposalId: string,
  options: { sentAt?: string | null; note?: string | null } = {}
): Promise<string> {
  const result = await client.rpc('crm_send_proposal', {
    p_proposal_id: proposalId,
    p_sent_at: options.sentAt ?? null,
    p_note: options.note ?? null
  });
  return unwrapRpc<string>(result, 'Could not mark the proposal as sent');
}

// ---------------------------------------------------------------------------
// Won → Client
// ---------------------------------------------------------------------------
export interface WinOpportunityInput {
  opportunity_id: string;
  company_name: string | null;
  client_status: ClientStatus;
  account_owner: string | null;
  start_date: string | null;
  renewal_date: string | null;
  create_contract: boolean;
  contract_status: ContractStatus;
  contract_start_date: string | null;
  contract_end_date: string | null;
  contract_monthly_value: number | null;
  contract_setup_fee: number | null;
  contract_document_url: string | null;
  note: string | null;
}

/**
 * Returns the client id. Safe to call twice: a second call returns the client
 * that already exists rather than creating another.
 */
export async function winOpportunity(
  client: CrmSupabaseClient,
  input: WinOpportunityInput
): Promise<string> {
  const result = await client.rpc('crm_win_opportunity', {
    p_opportunity_id: input.opportunity_id,
    p_company_name: input.company_name,
    p_client_status: input.client_status,
    p_account_owner: input.account_owner,
    p_start_date: input.start_date,
    p_renewal_date: input.renewal_date,
    p_create_contract: input.create_contract,
    p_contract_status: input.contract_status,
    p_contract_start_date: input.contract_start_date,
    p_contract_end_date: input.contract_end_date,
    p_contract_monthly_value: input.contract_monthly_value,
    p_contract_setup_fee: input.contract_setup_fee,
    p_contract_document_url: input.contract_document_url,
    p_note: input.note
  });
  return unwrapRpc<string>(result, 'Could not convert the deal to a client');
}

// ---------------------------------------------------------------------------
// Lost
// ---------------------------------------------------------------------------
export interface LoseOpportunityInput {
  opportunity_id: string;
  loss_reason: string;
  close_lead: boolean;
  lead_stage: LeadCloseStage;
  note: string | null;
}

/**
 * The reason is required by the database, not just by the form. "Lost" with no
 * reason is the least useful row a CRM can hold.
 *
 * The lead is closed only when it has no other live deal, and never when the
 * deal already became a client — that raises instead of orphaning the account.
 */
export async function loseOpportunity(
  client: CrmSupabaseClient,
  input: LoseOpportunityInput
): Promise<string> {
  const result = await client.rpc('crm_lose_opportunity', {
    p_opportunity_id: input.opportunity_id,
    p_loss_reason: input.loss_reason,
    p_close_lead: input.close_lead,
    p_lead_stage: input.lead_stage,
    p_note: input.note
  });
  return unwrapRpc<string>(result, 'Could not close the deal as lost');
}

// ---------------------------------------------------------------------------
// Call logging
// ---------------------------------------------------------------------------
export interface LogCallInput {
  crm_lead_id: string;
  summary: string;
  outcome: string | null;
  contact_id: string | null;
  opportunity_id: string | null;
  occurred_at: string | null;
  next_action: string | null;
  next_action_at: string | null;
  task_title: string | null;
  task_due_at: string | null;
}

/**
 * Saves the call, the follow-up and the task together.
 *
 * `direction` is fixed to `outbound` and not exposed: the call workspace is
 * for calls the agency makes. An `inbound` activity fires
 * `halt_outreach_on_inbound_reply` and advances the lead to `replied`, which
 * is a real state change that should come from an actual reply, not from a
 * dropdown someone left on the wrong value.
 *
 * Returns the activity id.
 */
export async function logCall(
  client: CrmSupabaseClient,
  input: LogCallInput
): Promise<string> {
  const result = await client.rpc('crm_log_call', {
    p_lead_id: input.crm_lead_id,
    p_summary: input.summary,
    p_outcome: input.outcome,
    p_contact_id: input.contact_id,
    p_opportunity_id: input.opportunity_id,
    p_occurred_at: input.occurred_at,
    p_direction: 'outbound',
    p_next_action: input.next_action,
    p_next_action_at: input.next_action_at,
    p_task_title: input.task_title,
    p_task_due_at: input.task_due_at
  });
  return unwrapRpc<string>(result, 'Could not save the call');
}

// ---------------------------------------------------------------------------
// Stage ordering, mirrored for the UI
// ---------------------------------------------------------------------------

/**
 * The same ranking as `crm_stage_rank()` in SQL.
 *
 * Duplicated on purpose rather than fetched: this decides whether to render a
 * "convert to opportunity" button, and a round trip to ask the database how to
 * draw a button is a poor trade. The test suite asserts the two agree by
 * parsing the migration, so drift fails the build rather than being noticed
 * later on a page that offers the wrong action.
 */
export const STAGE_RANK: Record<PipelineStage, number> = {
  qualified: 1,
  ready_for_outreach: 2,
  contacted: 3,
  replied: 4,
  appointment_booked: 5,
  sales_call: 6,
  proposal: 7,
  negotiation: 8,
  won: 9,
  lost: 0,
  disqualified: 0,
  do_not_contact: 0
};

/** Is this lead closed — an outcome rather than a step? */
export function isClosedStage(stage: PipelineStage): boolean {
  return STAGE_RANK[stage] === 0;
}

/** Would advancing to `target` move this lead forward? */
export function advances(from: PipelineStage, target: PipelineStage): boolean {
  return STAGE_RANK[from] > 0 && STAGE_RANK[target] > STAGE_RANK[from];
}

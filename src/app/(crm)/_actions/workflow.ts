'use server';

/**
 * The sales workflow actions: the five things that move a deal, as opposed to
 * the CRUD in `crud.ts` that edits one record's fields.
 *
 * Same shape as every other action here — authorise, validate, write,
 * revalidate, redirect back — with one addition. Each of these ends somewhere
 * new: converting a lead lands on the opportunities page, winning a deal lands
 * on the client it just created. A transition that leaves you staring at the
 * page you started from makes you go and check whether it worked.
 *
 * The writes themselves are RPCs into plpgsql functions, so each transition is
 * one transaction. See `src/lib/crm/workflow.ts`.
 */

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { safeDestination, withMessage } from '@/lib/crm/redirects';
import { readableWriteError, ValidationError } from '@/lib/crm/errors';
import { requireWriter } from '@/lib/crm/server';
import {
  CLIENT_STATUSES,
  CONTRACT_STATUSES,
  OPPORTUNITY_STAGES
} from '@/lib/crm/types';
import {
  bool,
  enumValue,
  optionalDate,
  optionalInt,
  optionalMoney,
  optionalText,
  optionalTimestamp,
  optionalUrl,
  optionalUuid,
  text,
  uuid
} from '@/lib/crm/validation';
import {
  convertLeadToOpportunity,
  LEAD_CLOSE_STAGES,
  logCall,
  loseOpportunity,
  markProposalSent,
  winOpportunity
} from '@/lib/crm/workflow';

function destination(form: FormData, fallback: string): string {
  // Shared, because six near-identical copies of this check is how one of them
  // ends up missing the backslash case. See src/lib/crm/redirects.ts.
  return safeDestination(form.get('return_to'), fallback);
}

function back(form: FormData, fallback: string, error?: unknown): never {
  const path = destination(form, fallback);
  if (error === undefined) redirect(path);
  redirect(withMessage(path, 'error', readableWriteError(error)));
}

/**
 * Redirect somewhere specific rather than back where we came from.
 *
 * Never called inside a `try`: `redirect()` works by throwing, so a catch
 * around it would swallow the navigation and report it as a failure.
 */
function go(path: string): never {
  redirect(path);
}

function refresh(paths: string[]): void {
  for (const path of paths) revalidatePath(path);
}

// ---------------------------------------------------------------------------
// Lead → Opportunity
// ---------------------------------------------------------------------------
export async function convertLead(form: FormData) {
  const leadId = uuid(form, 'crm_lead_id', 'Lead');
  const fallback = `/leads/${leadId}`;
  let opportunityId: string;

  try {
    const { client, userId } = await requireWriter();
    opportunityId = await convertLeadToOpportunity(client, {
      crm_lead_id: leadId,
      name: text(form, 'name', 'Opportunity name'),
      stage: enumValue(form, 'stage', OPPORTUNITY_STAGES, 'Stage', 'discovery'),
      contact_id: optionalUuid(form, 'contact_id'),
      owner_id: optionalUuid(form, 'owner_id') ?? userId,
      service_name: optionalText(form, 'service_name'),
      setup_fee: optionalMoney(form, 'setup_fee', 'Setup fee'),
      monthly_value: optionalMoney(form, 'monthly_value', 'Monthly value'),
      one_time_value: optionalMoney(form, 'one_time_value', 'One-off value'),
      contract_months: optionalInt(form, 'contract_months', 'Contract length', { min: 1 }),
      probability: optionalInt(form, 'probability', 'Probability', { min: 0, max: 100 }),
      expected_close_date: optionalDate(form, 'expected_close_date', 'Expected close date'),
      pain_points: optionalText(form, 'pain_points'),
      desired_outcome: optionalText(form, 'desired_outcome'),
      budget: optionalText(form, 'budget'),
      objections: optionalText(form, 'objections'),
      next_action: optionalText(form, 'next_action'),
      next_action_at: optionalTimestamp(form, 'next_action_at', 'Next action'),
      note: optionalText(form, 'note')
    });
  } catch (error) {
    back(form, fallback, error);
  }

  refresh([fallback, '/opportunities', '/pipeline', '/dashboard']);
  // The deal is the thing that now exists; the opportunities page is where it
  // is worked from here.
  go(`/opportunities?highlight=${opportunityId}`);
}

// ---------------------------------------------------------------------------
// Sales call
// ---------------------------------------------------------------------------
export async function saveCall(form: FormData) {
  const leadId = uuid(form, 'crm_lead_id', 'Lead');
  const fallback = `/leads/${leadId}/call`;

  try {
    const { client } = await requireWriter();
    await logCall(client, {
      crm_lead_id: leadId,
      summary: text(form, 'summary', 'Call notes'),
      outcome: optionalText(form, 'outcome'),
      contact_id: optionalUuid(form, 'contact_id'),
      opportunity_id: optionalUuid(form, 'opportunity_id'),
      occurred_at: optionalTimestamp(form, 'occurred_at', 'Call time'),
      next_action: optionalText(form, 'next_action'),
      next_action_at: optionalTimestamp(form, 'next_action_at', 'Next action'),
      task_title: optionalText(form, 'task_title'),
      task_due_at: optionalTimestamp(form, 'task_due_at', 'Task due')
    });
  } catch (error) {
    back(form, fallback, error);
  }

  refresh([`/leads/${leadId}`, fallback, '/tasks', '/dashboard', '/opportunities']);
  // Back to the lead: the call is over, and the timeline is where its result
  // now lives.
  go(`/leads/${leadId}`);
}

// ---------------------------------------------------------------------------
// Proposal sent
// ---------------------------------------------------------------------------
export async function sendProposal(form: FormData) {
  const fallback = destination(form, '/opportunities');

  try {
    const { client } = await requireWriter();
    await markProposalSent(client, uuid(form, 'id', 'Proposal'), {
      sentAt: optionalTimestamp(form, 'sent_at', 'Sent at'),
      note: optionalText(form, 'note')
    });
  } catch (error) {
    back(form, fallback, error);
  }

  refresh(['/opportunities', '/pipeline', '/dashboard']);
  const leadId = optionalUuid(form, 'crm_lead_id');
  if (leadId) refresh([`/leads/${leadId}`]);
  back(form, fallback);
}

// ---------------------------------------------------------------------------
// Won → Client
// ---------------------------------------------------------------------------
export async function markWon(form: FormData) {
  const fallback = destination(form, '/opportunities');
  let clientId: string;

  try {
    const { client, userId } = await requireWriter();
    const createContract = bool(form, 'create_contract');
    const contractStatus = enumValue(
      form, 'contract_status', CONTRACT_STATUSES, 'Contract status', 'signed'
    );
    const startDate = optionalDate(form, 'start_date', 'Start date');
    const contractEnd = optionalDate(form, 'contract_end_date', 'Contract end date');
    const contractStart = optionalDate(form, 'contract_start_date', 'Contract start date');

    // Checked here as well as by the table constraint, because the constraint
    // message names a constraint and this names the two fields.
    if (createContract && contractStart && contractEnd && contractEnd < contractStart) {
      throw new ValidationError('The contract cannot end before it starts.');
    }

    clientId = await winOpportunity(client, {
      opportunity_id: uuid(form, 'id', 'Opportunity'),
      company_name: optionalText(form, 'company_name'),
      client_status: enumValue(form, 'client_status', CLIENT_STATUSES, 'Client status', 'onboarding'),
      account_owner: optionalUuid(form, 'account_owner') ?? userId,
      start_date: startDate,
      renewal_date: optionalDate(form, 'renewal_date', 'Renewal date'),
      create_contract: createContract,
      contract_status: contractStatus,
      contract_start_date: contractStart,
      contract_end_date: contractEnd,
      contract_monthly_value: optionalMoney(form, 'contract_monthly_value', 'Contract monthly value'),
      contract_setup_fee: optionalMoney(form, 'contract_setup_fee', 'Contract setup fee'),
      contract_document_url: optionalUrl(form, 'contract_document_url', 'Contract document'),
      note: optionalText(form, 'note')
    });
  } catch (error) {
    back(form, fallback, error);
  }

  refresh(['/opportunities', '/clients', '/pipeline', '/dashboard', '/payments']);
  const leadId = optionalUuid(form, 'crm_lead_id');
  if (leadId) refresh([`/leads/${leadId}`]);
  // Land on the account that now exists — there is onboarding to do on it.
  go(`/clients/${clientId}`);
}

// ---------------------------------------------------------------------------
// Lost
// ---------------------------------------------------------------------------
export async function markLost(form: FormData) {
  const fallback = destination(form, '/opportunities');

  try {
    const { client } = await requireWriter();
    await loseOpportunity(client, {
      opportunity_id: uuid(form, 'id', 'Opportunity'),
      loss_reason: text(form, 'loss_reason', 'Reason'),
      close_lead: bool(form, 'close_lead'),
      lead_stage: enumValue(form, 'lead_stage', LEAD_CLOSE_STAGES, 'Lead outcome', 'lost'),
      note: optionalText(form, 'note')
    });
  } catch (error) {
    back(form, fallback, error);
  }

  refresh(['/opportunities', '/pipeline', '/dashboard']);
  const leadId = optionalUuid(form, 'crm_lead_id');
  if (leadId) refresh([`/leads/${leadId}`]);
  back(form, fallback);
}

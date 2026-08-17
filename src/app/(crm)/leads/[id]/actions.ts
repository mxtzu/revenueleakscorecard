'use server';

/**
 * Mutations for the lead detail page.
 *
 * Three layers, deliberately:
 *
 *   1. The UI hides write forms from roles that cannot use them.
 *   2. These actions re-check the role, because hiding a form stops nobody who
 *      can craft a POST — and a form submitted just as an admin demotes you
 *      would otherwise reach the database on a stale assumption.
 *   3. RLS refuses the write regardless. That is the actual guarantee; 1 and 2
 *      exist so the user gets a sentence instead of a Postgres error.
 *
 * Failures redirect back with a readable message rather than throwing. An
 * uncaught throw in a Server Action replaces the whole page with the error
 * boundary, losing whatever else was on screen.
 */

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { assertCanWrite, PermissionError } from '@/lib/crm/permissions';
import { getCurrentProfile, recordActivity, setPipelineStage } from '@/lib/crm/queries';
import { crmClient } from '@/lib/crm/server';
import { isPipelineStage } from '@/lib/crm/types';
import type { CrmSupabaseClient } from '@/lib/crm/supabase';

function optional(formData: FormData, key: string): string | null {
  const value = String(formData.get(key) ?? '').trim();
  return value.length ? value : null;
}

/** Resolve the caller and confirm their role permits writing. */
async function writer(): Promise<{ client: CrmSupabaseClient; userId: string | null }> {
  const client = crmClient();
  const profile = await getCurrentProfile(client);
  assertCanWrite(profile);
  return { client, userId: profile?.id ?? null };
}

function failureMessage(error: unknown): string {
  if (error instanceof PermissionError) return error.message;
  const message = error instanceof Error ? error.message : String(error);
  // RLS denials are accurate but unreadable; everything else is worth showing.
  if (/row-level security|permission denied/i.test(message)) {
    return 'The database refused that write. Your role may have changed — reload and try again.';
  }
  return message;
}

/** Redirect back to the lead with an error banner. Never returns. */
function fail(leadId: string, error: unknown): never {
  redirect(`/leads/${leadId}?error=${encodeURIComponent(failureMessage(error))}`);
}

export async function changeStage(formData: FormData) {
  const id = String(formData.get('lead_id') ?? '');
  const stage = String(formData.get('stage') ?? '');
  if (!id) throw new Error('A lead id is required.');
  if (!isPipelineStage(stage)) fail(id, new Error(`"${stage}" is not a pipeline stage.`));

  const reason = optional(formData, 'reason');

  try {
    const { client } = await writer();
    await setPipelineStage(client, id, stage, {
      // The reason column depends on why the lead closed; storing a loss reason
      // on a disqualification (or vice versa) would corrupt both reports.
      ...(stage === 'lost' ? { loss_reason: reason } : {}),
      ...(stage === 'disqualified' || stage === 'do_not_contact'
        ? { disqualification_reason: reason }
        : {})
    });
  } catch (error) {
    fail(id, error);
  }

  revalidatePath(`/leads/${id}`);
  revalidatePath('/leads');
  revalidatePath('/pipeline');
}

export async function addNote(formData: FormData) {
  const id = String(formData.get('lead_id') ?? '');
  const body = String(formData.get('body') ?? '').trim();
  if (!id) throw new Error('A lead id is required.');
  if (!body) fail(id, new Error('A note needs some text.'));

  try {
    const { client, userId } = await writer();
    await recordActivity(client, {
      crm_lead_id: id,
      client_id: null,
      contact_id: null,
      user_id: userId,
      type: 'note',
      direction: 'internal',
      subject: optional(formData, 'subject'),
      body,
      outcome: null
    });
  } catch (error) {
    fail(id, error);
  }

  revalidatePath(`/leads/${id}`);
}

/**
 * Log a call or an email that already happened.
 *
 * This records history — it does not send anything. Outbound sending is
 * deliberately not built: the CRM is a research and tracking system, and every
 * message still goes out by a human hand.
 */
export async function logCommunication(formData: FormData) {
  const id = String(formData.get('lead_id') ?? '');
  const type = String(formData.get('type') ?? '');
  const direction = String(formData.get('direction') ?? '');
  if (!id) throw new Error('A lead id is required.');
  if (type !== 'call' && type !== 'email' && type !== 'meeting') {
    fail(id, new Error('Only calls, emails and meetings can be logged here.'));
  }
  if (direction !== 'inbound' && direction !== 'outbound') {
    fail(id, new Error('Direction must be inbound or outbound.'));
  }

  try {
    const { client, userId } = await writer();
    await recordActivity(client, {
      crm_lead_id: id,
      client_id: null,
      contact_id: null,
      user_id: userId,
      type,
      direction,
      subject: optional(formData, 'subject'),
      body: optional(formData, 'body'),
      outcome: optional(formData, 'outcome')
    });
  } catch (error) {
    fail(id, error);
  }

  // An inbound reply halts outreach and advances the stage via a database
  // trigger, so the lead row may have changed too.
  revalidatePath(`/leads/${id}`);
  revalidatePath('/leads');
  revalidatePath('/pipeline');
}

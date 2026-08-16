'use server';

/**
 * Mutations for the lead detail page.
 *
 * Every one runs through the session-scoped client, so RLS decides whether the
 * caller may write — a viewer submitting the form by hand gets a database
 * error, not a silent success. Nothing here uses the service role.
 */

import { revalidatePath } from 'next/cache';

import { recordActivity, setPipelineStage } from '@/lib/crm/queries';
import { crmClient } from '@/lib/crm/server';
import { isPipelineStage } from '@/lib/crm/types';

function optional(formData: FormData, key: string): string | null {
  const value = String(formData.get(key) ?? '').trim();
  return value.length ? value : null;
}

export async function changeStage(formData: FormData) {
  const id = String(formData.get('lead_id') ?? '');
  const stage = String(formData.get('stage') ?? '');
  if (!id || !isPipelineStage(stage)) {
    throw new Error('A lead id and a valid pipeline stage are required.');
  }

  const reason = optional(formData, 'reason');
  await setPipelineStage(crmClient(), id, stage, {
    // The reason column depends on why the lead closed; storing a loss reason
    // on a disqualification (or vice versa) would corrupt both reports.
    ...(stage === 'lost' ? { loss_reason: reason } : {}),
    ...(stage === 'disqualified' || stage === 'do_not_contact'
      ? { disqualification_reason: reason }
      : {})
  });

  revalidatePath(`/leads/${id}`);
  revalidatePath('/leads');
  revalidatePath('/pipeline');
}

export async function addNote(formData: FormData) {
  const id = String(formData.get('lead_id') ?? '');
  const body = String(formData.get('body') ?? '').trim();
  if (!id || !body) throw new Error('A lead id and note text are required.');

  const client = crmClient();
  const { data } = await client.auth.getUser();

  await recordActivity(client, {
    crm_lead_id: id,
    client_id: null,
    contact_id: null,
    user_id: data.user?.id ?? null,
    type: 'note',
    direction: 'internal',
    subject: optional(formData, 'subject'),
    body,
    outcome: null
  });

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
    throw new Error('Only calls, emails and meetings can be logged here.');
  }
  if (direction !== 'inbound' && direction !== 'outbound') {
    throw new Error('Direction must be inbound or outbound.');
  }

  const client = crmClient();
  const { data } = await client.auth.getUser();

  await recordActivity(client, {
    crm_lead_id: id,
    client_id: null,
    contact_id: null,
    user_id: data.user?.id ?? null,
    type,
    direction,
    subject: optional(formData, 'subject'),
    body: optional(formData, 'body'),
    outcome: optional(formData, 'outcome')
  });

  // An inbound reply halts outreach and advances the stage via a database
  // trigger, so the lead row may have changed too.
  revalidatePath(`/leads/${id}`);
  revalidatePath('/leads');
  revalidatePath('/pipeline');
}

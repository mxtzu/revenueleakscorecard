'use server';

/**
 * Contracts, proposals, documents and outreach sequences.
 *
 * Same shape as `crud.ts`: authorise, validate, write, revalidate, redirect
 * back with `?error=` on failure.
 *
 * These four exist so the data model does not need re-cutting later. Two
 * deliberate limits:
 *
 *   - Nothing here sends anything. A sequence is a set of templates you write;
 *     enrolling a lead and firing the steps is the outreach engine, which is
 *     explicitly not built.
 *   - `payments` is still absent. Stripe is the source of truth for whether
 *     money arrived, and the table has no write policy for exactly that reason.
 */

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { safeDestination, withMessage } from '@/lib/crm/redirects';
import { readableWriteError, ValidationError } from '@/lib/crm/errors';
import {
  createContract,
  createDocument,
  createProposal,
  createSequence,
  createStep,
  deleteContract,
  deleteDocument,
  deleteProposal,
  deleteSequence,
  deleteStep,
  updateContract,
  updateProposal,
  updateSequence,
  updateStep
} from '@/lib/crm/mutations';
import { getDocumentById } from '@/lib/crm/queries';
import { requireAdmin, requireWriter } from '@/lib/crm/server';
import {
  CONTRACT_STATUSES,
  OUTREACH_CHANNELS,
  PROPOSAL_STATUSES
} from '@/lib/crm/types';
import {
  bool,
  enumValue,
  optionalDate,
  optionalInt,
  optionalMoney,
  optionalText,
  optionalUrl,
  optionalUuid,
  text,
  uploadedFile,
  uuid
} from '@/lib/crm/validation';

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

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------
export async function saveContract(form: FormData) {
  const clientId = uuid(form, 'client_id', 'Client');
  const fallback = `/clients/${clientId}`;
  try {
    const { client } = await requireWriter();
    const id = optionalUuid(form, 'id');
    const fields = {
      client_id: clientId,
      status: enumValue(form, 'status', CONTRACT_STATUSES, 'Status', 'draft'),
      start_date: optionalDate(form, 'start_date', 'Start date'),
      end_date: optionalDate(form, 'end_date', 'End date'),
      monthly_value: optionalMoney(form, 'monthly_value', 'Monthly value'),
      setup_fee: optionalMoney(form, 'setup_fee', 'Setup fee'),
      document_url: optionalUrl(form, 'document_url', 'Document link')
    };
    if (fields.start_date && fields.end_date && fields.end_date < fields.start_date) {
      throw new ValidationError('The end date cannot be before the start date.');
    }
    if (id) await updateContract(client, id, fields);
    else await createContract(client, fields);
  } catch (error) {
    back(form, fallback, error);
  }
  revalidatePath(fallback);
  back(form, fallback);
}

export async function removeContract(form: FormData) {
  const clientId = uuid(form, 'client_id', 'Client');
  const fallback = `/clients/${clientId}`;
  try {
    const { client } = await requireAdmin();
    await deleteContract(client, uuid(form, 'id', 'Contract'));
  } catch (error) {
    back(form, fallback, error);
  }
  revalidatePath(fallback);
  back(form, fallback);
}

// ---------------------------------------------------------------------------
// Proposals
// ---------------------------------------------------------------------------
export async function saveProposal(form: FormData) {
  const fallback = '/opportunities';
  try {
    const { client, userId } = await requireWriter();
    const id = optionalUuid(form, 'id');
    const fields = {
      opportunity_id: uuid(form, 'opportunity_id', 'Opportunity'),
      status: enumValue(form, 'status', PROPOSAL_STATUSES, 'Status', 'draft'),
      title: optionalText(form, 'title'),
      total_value: optionalMoney(form, 'total_value', 'Total value'),
      setup_fee: optionalMoney(form, 'setup_fee', 'Setup fee'),
      monthly_value: optionalMoney(form, 'monthly_value', 'Monthly value'),
      valid_until: optionalDate(form, 'valid_until', 'Valid until'),
      document_url: optionalUrl(form, 'document_url', 'Document link')
    };
    // Version is derived on create, never typed — see nextProposalVersion.
    if (id) await updateProposal(client, id, fields);
    else await createProposal(client, fields, userId);
    revalidatePath('/opportunities');
  } catch (error) {
    back(form, fallback, error);
  }
  back(form, fallback);
}

export async function removeProposal(form: FormData) {
  const fallback = '/opportunities';
  try {
    const { client } = await requireAdmin();
    await deleteProposal(client, uuid(form, 'id', 'Proposal'));
    revalidatePath('/opportunities');
  } catch (error) {
    back(form, fallback, error);
  }
  back(form, fallback);
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------
export async function uploadDocument(form: FormData) {
  const leadId = optionalUuid(form, 'crm_lead_id');
  const clientId = optionalUuid(form, 'client_id');
  const fallback = leadId ? `/leads/${leadId}` : `/clients/${clientId}`;
  try {
    if (!leadId && !clientId) {
      throw new ValidationError('A document has to belong to a lead or a client.');
    }
    const { client, userId } = await requireWriter();
    const file = uploadedFile(form, 'file');
    await createDocument(
      client,
      {
        crm_lead_id: leadId,
        client_id: clientId,
        // The typed name is a label; the file keeps its own name in storage.
        name: optionalText(form, 'name') ?? file.name,
        file
      },
      userId
    );
  } catch (error) {
    back(form, fallback, error);
  }
  revalidatePath(fallback);
  back(form, fallback);
}

export async function removeDocument(form: FormData) {
  const leadId = optionalUuid(form, 'crm_lead_id');
  const clientId = optionalUuid(form, 'client_id');
  const fallback = leadId ? `/leads/${leadId}` : `/clients/${clientId}`;
  try {
    const { client } = await requireAdmin();
    const id = uuid(form, 'id', 'Document');
    // Read the path through RLS rather than trusting a hidden field: a forged
    // one would delete another record's file.
    const document = await getDocumentById(client, id);
    if (!document) throw new ValidationError('That document no longer exists.');
    await deleteDocument(client, id, document.storage_path);
  } catch (error) {
    back(form, fallback, error);
  }
  revalidatePath(fallback);
  back(form, fallback);
}

// ---------------------------------------------------------------------------
// Outreach sequences and steps
// ---------------------------------------------------------------------------
const OUTREACH = '/outreach';

export async function saveSequence(form: FormData) {
  try {
    const { client, userId } = await requireWriter();
    const id = optionalUuid(form, 'id');
    const fields = {
      name: text(form, 'name', 'Sequence name'),
      description: optionalText(form, 'description'),
      active: bool(form, 'active')
    };
    if (id) await updateSequence(client, id, fields);
    else await createSequence(client, fields, userId);
    revalidatePath(OUTREACH);
  } catch (error) {
    back(form, OUTREACH, error);
  }
  back(form, OUTREACH);
}

export async function removeSequence(form: FormData) {
  try {
    const { client } = await requireAdmin();
    await deleteSequence(client, uuid(form, 'id', 'Sequence'));
    revalidatePath(OUTREACH);
  } catch (error) {
    back(form, OUTREACH, error);
  }
  back(form, OUTREACH);
}

export async function saveStep(form: FormData) {
  try {
    const { client } = await requireWriter();
    const id = optionalUuid(form, 'id');
    const fields = {
      sequence_id: uuid(form, 'sequence_id', 'Sequence'),
      channel: enumValue(form, 'channel', OUTREACH_CHANNELS, 'Channel', 'email'),
      delay_minutes: optionalInt(form, 'delay_minutes', 'Delay', { min: 0 }) ?? 0,
      subject_template: optionalText(form, 'subject_template'),
      body_template: optionalText(form, 'body_template'),
      active: bool(form, 'active')
    };
    const stepNumber = optionalInt(form, 'step_number', 'Step number', { min: 1 });
    if (id) {
      if (stepNumber === null) throw new ValidationError('Step number is required.');
      await updateStep(client, id, { ...fields, step_number: stepNumber });
    } else {
      // Derived when absent, so two people adding a step do not both pick 3.
      await createStep(client, { ...fields, step_number: stepNumber ?? undefined });
    }
    revalidatePath(OUTREACH);
  } catch (error) {
    back(form, OUTREACH, error);
  }
  back(form, OUTREACH);
}

export async function removeStep(form: FormData) {
  try {
    const { client } = await requireAdmin();
    await deleteStep(client, uuid(form, 'id', 'Step'));
    revalidatePath(OUTREACH);
  } catch (error) {
    back(form, OUTREACH, error);
  }
  back(form, OUTREACH);
}

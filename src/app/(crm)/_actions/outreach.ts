'use server';

/**
 * Outreach actions: enrol, pause, stop, suppress, and configure.
 *
 * Enrolment is a deliberate human act. Nothing bulk-enrols a scraped list —
 * the pipeline finds businesses, a person decides which of them to write to,
 * and that decision is recorded with their name on it (`enrolled_by`).
 *
 * Turning sending on is admin-only, matching the RLS policy on
 * `outreach_settings`. It is the single control that decides whether this CRM
 * contacts anybody at all.
 */

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { safeDestination, withMessage } from '@/lib/crm/redirects';
import { readableWriteError, ValidationError } from '@/lib/crm/errors';
import { requireAdmin, requireWriter } from '@/lib/crm/server';
import { createServiceClient, isServiceRoleConfigured } from '@/lib/crm/supabase';
import {
  bool,
  enumValue,
  optionalInt,
  optionalText,
  optionalUuid,
  timezone,
  uuid
} from '@/lib/crm/validation';

const SUPPRESSION_REASONS = ['manual', 'unsubscribed', 'bounced', 'complained', 'invalid'] as const;

function destination(form: FormData, fallback: string): string {
  // Shared, because six near-identical copies of this check is how one of them
  // ends up missing the backslash case. See src/lib/crm/redirects.ts.
  return safeDestination(form.get('return_to'), fallback);
}

function back(form: FormData, fallback: string, key: 'error' | 'notice', message?: string): never {
  const path = destination(form, fallback);
  if (!message) redirect(path);
  redirect(withMessage(path, key, message));
}

function refresh(leadId?: string | null): void {
  revalidatePath('/outreach');
  revalidatePath('/dashboard');
  if (leadId) revalidatePath(`/leads/${leadId}`);
}

// ---------------------------------------------------------------------------
// Enrolment
// ---------------------------------------------------------------------------

/**
 * Put one lead into one sequence.
 *
 * Refuses up front when the address is already suppressed. RLS would not stop
 * this — the enrolment row is legitimate — and the engine would refuse at send
 * time anyway, but telling somebody now beats letting them think it worked.
 */
export async function enrolLead(form: FormData) {
  const leadId = uuid(form, 'crm_lead_id', 'Lead');
  const fallback = `/leads/${leadId}`;
  let notice: string;

  try {
    const { client, userId } = await requireWriter();
    const sequenceId = uuid(form, 'sequence_id', 'Sequence');
    const contactId = optionalUuid(form, 'contact_id');

    const { data: leadRow } = await client
      .from('crm_leads')
      .select('pipeline_stage')
      .eq('id', leadId)
      .maybeSingle();
    const stage = (leadRow as { pipeline_stage: string } | null)?.pipeline_stage;
    if (stage === 'do_not_contact') {
      throw new ValidationError('This lead is marked do-not-contact.');
    }

    // Check consent before creating anything.
    let email: string | null = null;
    let phone: string | null = null;
    if (contactId) {
      const { data } = await client.from('contacts').select('email, phone').eq('id', contactId).maybeSingle();
      const contact = data as { email: string | null; phone: string | null } | null;
      email = contact?.email ?? null;
      phone = contact?.phone ?? null;
    }
    if (!email) {
      const { data } = await client
        .from('lead_intelligence')
        .select('business_email, business_phone')
        .eq('crm_lead_id', leadId)
        .maybeSingle();
      const intel = data as { business_email: string | null; business_phone: string | null } | null;
      email = email ?? intel?.business_email ?? null;
      phone = phone ?? intel?.business_phone ?? null;
    }

    const { data: suppressed } = await client.rpc('crm_is_suppressed', {
      p_email: email,
      p_phone: phone
    });
    if (suppressed) {
      throw new ValidationError('That address is on the do-not-contact list, so nothing was enrolled.');
    }
    if (!email && !phone) {
      throw new ValidationError('This lead has no email address or phone number to write to.');
    }

    const { error } = await client.from('lead_outreach').insert({
      crm_lead_id: leadId,
      sequence_id: sequenceId,
      contact_id: contactId,
      enrolled_by: userId,
      status: 'active',
      current_step: 0,
      // Due immediately; the engine's window and cap decide when it actually
      // goes out.
      next_step_at: new Date().toISOString()
    });
    if (error) {
      throw new Error(
        /duplicate key/i.test(error.message)
          ? 'This lead is already enrolled in that sequence.'
          : error.message
      );
    }

    notice = 'Enrolled. The first step goes out on the next run, inside the sending window.';
  } catch (error) {
    back(form, fallback, 'error', readableWriteError(error));
  }

  refresh(leadId);
  back(form, fallback, 'notice', notice);
}

/** Pause, resume or stop one enrolment. */
export async function setEnrolmentStatus(form: FormData) {
  const fallback = destination(form, '/outreach');
  let notice: string;

  try {
    const { client } = await requireWriter();
    const id = uuid(form, 'id', 'Enrolment');
    const status = enumValue(form, 'status', ['active', 'paused', 'stopped'] as const, 'Status');

    const { error } = await client
      .from('lead_outreach')
      .update({
        status,
        stop_reason: status === 'stopped' ? (optionalText(form, 'reason') ?? 'Stopped by hand') : null,
        stopped_at: status === 'stopped' ? new Date().toISOString() : null,
        // Resuming makes it due now; the window still applies.
        next_step_at: status === 'active' ? new Date().toISOString() : null
      })
      .eq('id', id);
    if (error) throw new Error(error.message);

    notice =
      status === 'active' ? 'Resumed.' : status === 'paused' ? 'Paused.' : 'Stopped.';
  } catch (error) {
    back(form, fallback, 'error', readableWriteError(error));
  }

  refresh(optionalText(form, 'crm_lead_id'));
  back(form, fallback, 'notice', notice);
}

// ---------------------------------------------------------------------------
// Suppression
// ---------------------------------------------------------------------------

/**
 * Add an address to the do-not-contact list.
 *
 * Open to any writing role: "never contact this address again" is a request
 * anybody should be able to honour the moment they hear it, without finding an
 * admin.
 */
export async function suppressAddress(form: FormData) {
  const fallback = destination(form, '/outreach');
  let notice: string;

  try {
    const { client, userId } = await requireWriter();
    const email = optionalText(form, 'email');
    const phone = optionalText(form, 'phone');
    if (!email && !phone) {
      throw new ValidationError('Give an email address or a phone number to suppress.');
    }

    const { error } = await client.from('suppressions').insert({
      email,
      phone,
      reason: enumValue(form, 'reason', SUPPRESSION_REASONS, 'Reason', 'manual'),
      source: 'added by hand',
      notes: optionalText(form, 'notes'),
      crm_lead_id: optionalUuid(form, 'crm_lead_id'),
      created_by: userId
    });
    if (error) {
      // Already on the list is the state we wanted.
      if (!/duplicate key/i.test(error.message)) throw new Error(error.message);
    }

    // Stop anything live for that lead at the same time, or the sequence keeps
    // running until the engine next checks.
    const leadId = optionalUuid(form, 'crm_lead_id');
    if (leadId) {
      await client
        .from('lead_outreach')
        .update({
          status: 'stopped',
          stopped_at: new Date().toISOString(),
          stop_reason: 'Address suppressed',
          next_step_at: null
        })
        .eq('crm_lead_id', leadId);
    }

    notice = 'Added to the do-not-contact list. Nothing further will be sent to it.';
  } catch (error) {
    back(form, fallback, 'error', readableWriteError(error));
  }

  refresh(optionalText(form, 'crm_lead_id'));
  back(form, fallback, 'notice', notice);
}

/** Remove a suppression. Admin-only: this is what puts an address back in the send path. */
export async function unsuppressAddress(form: FormData) {
  const fallback = destination(form, '/outreach');
  try {
    const { client } = await requireAdmin();
    const { error } = await client.from('suppressions').delete().eq('id', uuid(form, 'id', 'Entry'));
    if (error) throw new Error(error.message);
  } catch (error) {
    back(form, fallback, 'error', readableWriteError(error));
  }
  refresh();
  back(form, fallback, 'notice', 'Removed from the do-not-contact list.');
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * Change the sending configuration.
 *
 * Admin-only, matching the RLS policy. Turning `sending_enabled` on is not a
 * decision for whoever happens to be logged in.
 */
export async function saveOutreachSettings(form: FormData) {
  const fallback = destination(form, '/outreach');
  let notice: string;

  try {
    const { client, userId } = await requireAdmin();

    const start = optionalInt(form, 'send_window_start', 'Window start', { min: 0, max: 23 }) ?? 9;
    const end = optionalInt(form, 'send_window_end', 'Window end', { min: 1, max: 24 }) ?? 17;
    if (end <= start) {
      throw new ValidationError('The sending window has to end after it starts.');
    }

    const enabled = bool(form, 'sending_enabled');
    const fromEmail = optionalText(form, 'from_email');
    if (enabled && !fromEmail) {
      // Refusing here beats enabling a switch that produces nothing but
      // skipped rows.
      throw new ValidationError('Set a sending address before turning sending on.');
    }

    const { error } = await client
      .from('outreach_settings')
      .update({
        sending_enabled: enabled,
        from_name: optionalText(form, 'from_name'),
        from_email: fromEmail,
        reply_to_email: optionalText(form, 'reply_to_email'),
        sms_from_number: optionalText(form, 'sms_from_number'),
        postal_address: optionalText(form, 'postal_address'),
        daily_send_limit: optionalInt(form, 'daily_send_limit', 'Daily limit', { min: 0, max: 5000 }) ?? 50,
        per_run_limit: optionalInt(form, 'per_run_limit', 'Per-run limit', { min: 0, max: 500 }) ?? 25,
        send_window_start: start,
        send_window_end: end,
        send_on_weekends: bool(form, 'send_on_weekends'),
        timezone: timezone(form, 'timezone'),
        updated_by: userId
      })
      .eq('id', true);
    if (error) throw new Error(error.message);

    notice = enabled
      ? 'Saved. Sending is ON — the engine will contact leads on its next run.'
      : 'Saved. Sending is off; nothing will go out.';
  } catch (error) {
    back(form, fallback, 'error', readableWriteError(error));
  }

  refresh();
  back(form, fallback, 'notice', notice);
}

// ---------------------------------------------------------------------------
// Run now
// ---------------------------------------------------------------------------

/**
 * Run the engine immediately, without waiting for the scheduler.
 *
 * Admin-only for the same reason as the settings: this is the control that
 * puts messages in front of strangers.
 */
export async function runOutreachNow(form: FormData) {
  const fallback = destination(form, '/outreach');
  let notice: string;

  try {
    await requireAdmin();
    if (!isServiceRoleConfigured()) {
      throw new ValidationError('SUPABASE_SERVICE_ROLE_KEY is not set, so the engine cannot run.');
    }

    const { runOutreach } = await import('@/lib/outreach/engine');
    const { emailProvider, smsProvider, siteUrl } = await import('@/lib/outreach/config');

    const result = await runOutreach({
      service: createServiceClient(),
      email: emailProvider(),
      sms: smsProvider(),
      siteUrl: siteUrl()
    });

    const parts = [
      `${result.sent} sent`,
      result.tasksCreated ? `${result.tasksCreated} task(s) created` : null,
      result.skipped ? `${result.skipped} skipped` : null,
      result.failed ? `${result.failed} failed` : null
    ].filter(Boolean);

    notice =
      result.considered === 0 && result.sent === 0
        ? `Nothing was due. ${result.reasons[0] ?? ''}`.trim()
        : `Run complete — ${parts.join(', ')}.${result.reasons[0] ? ` First reason: ${result.reasons[0]}` : ''}`;
  } catch (error) {
    back(form, fallback, 'error', readableWriteError(error));
  }

  refresh();
  back(form, fallback, 'notice', notice);
}

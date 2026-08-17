/**
 * The sending engine.
 *
 * One pass over the enrolments whose next step is due: check the gates, render
 * the step, send it, record it, advance. Runs as the service role, because
 * `outreach_messages` has no write policy for any CRM role — what was sent is
 * a record, not something a browser can assert.
 *
 * Three properties this has to hold, all of them about not doing the wrong
 * thing twice:
 *
 *   EVERY DECISION IS RECORDED. A skipped send writes a row with its reason.
 *   Silence would make "why did this lead never get step 3" unanswerable.
 *
 *   A STEP IS SENT ONCE. `outreach_messages_one_per_step` is a unique index, so
 *   two overlapping runs race on the database rather than both emailing.
 *
 *   A REPLY ENDS IT. Not implemented here — inbound writes an activity and the
 *   `halt_outreach_on_inbound_reply` trigger from the first migration stops the
 *   enrolment. A second implementation could disagree with the first.
 */

import type { CrmSupabaseClient } from '@/lib/crm/supabase';
import type { PipelineStage } from '@/lib/crm/types';

import { blockedReason, isTransientBlock, type OutreachSettings } from './gate';
import {
  ProviderError,
  type EmailProvider,
  type SmsProvider,
  type Transport
} from './providers';
import {
  emailFooter,
  render,
  TemplateError,
  textToHtml,
  type TemplateContext
} from './templates';

export interface RunResult {
  considered: number;
  sent: number;
  skipped: number;
  failed: number;
  tasksCreated: number;
  completed: number;
  reasons: string[];
}

export function emptyRun(): RunResult {
  return { considered: 0, sent: 0, skipped: 0, failed: 0, tasksCreated: 0, completed: 0, reasons: [] };
}

interface DueEnrolment {
  id: string;
  crm_lead_id: string;
  sequence_id: string;
  contact_id: string | null;
  current_step: number;
  unsubscribe_token: string;
}

interface Step {
  id: string;
  step_number: number;
  channel: string;
  delay_minutes: number;
  subject_template: string | null;
  body_template: string | null;
  task_title: string | null;
  ignore_send_window: boolean;
  active: boolean;
}

export interface EngineDeps {
  service: CrmSupabaseClient;
  email: EmailProvider | null;
  sms: SmsProvider | null;
  transport?: Transport;
  /** Base URL for unsubscribe links. */
  siteUrl: string;
  now?: Date;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function unsubscribeUrl(siteUrl: string, token: string): string {
  return `${siteUrl.replace(/\/$/, '')}/api/crm/outreach/unsubscribe?token=${encodeURIComponent(token)}`;
}

export async function readSettings(service: CrmSupabaseClient): Promise<OutreachSettings> {
  const { data, error } = await service.from('outreach_settings').select('*').eq('id', true).maybeSingle();
  if (error) throw new Error(`Could not read outreach settings: ${error.message}`);
  if (!data) throw new Error('Outreach settings row is missing. Re-apply 20260821_outreach_engine.sql.');
  return data as unknown as OutreachSettings;
}

/** How many sends have already gone out today, for the daily cap. */
async function sentToday(service: CrmSupabaseClient, now: Date): Promise<number> {
  const startOfDay = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  ).toISOString();

  const { data, error } = await service
    .from('outreach_messages')
    .select('id')
    .gte('sent_at', startOfDay)
    .limit(10_000);
  if (error) throw new Error(`Could not count today's sends: ${error.message}`);
  return (data ?? []).length;
}

/**
 * Build the substitution context for one lead.
 *
 * `top_opportunity` comes from the pipeline's own findings — it is the reason
 * for writing at all, and a template that references it produces a specific
 * first line instead of a generic one.
 */
export function buildContext(
  intelligence: Record<string, unknown> | null,
  contact: Record<string, unknown> | null,
  senderName: string | null
): TemplateContext {
  const opportunities = (intelligence?.opportunities as string[] | undefined) ?? [];
  return {
    first_name: (contact?.first_name as string) ?? null,
    last_name: (contact?.last_name as string) ?? null,
    full_name: (contact?.full_name as string) ?? (intelligence?.contact_name as string) ?? null,
    job_title: (contact?.job_title as string) ?? null,
    company_name: (intelligence?.company_name as string) ?? null,
    city: (intelligence?.city as string) ?? null,
    niche: (intelligence?.niche as string) ?? null,
    website: (intelligence?.website as string) ?? null,
    sender_name: senderName,
    top_opportunity: opportunities[0] ?? null
  };
}

/**
 * Advance an enrolment to its next step, or finish it.
 *
 * The delay is measured from now rather than from the step's scheduled time, so
 * a run that happens late does not immediately fire the next two steps to catch
 * up — which would arrive as a burst.
 */
async function advance(
  service: CrmSupabaseClient,
  enrolment: DueEnrolment,
  steps: Step[],
  now: Date,
  result: RunResult
): Promise<void> {
  const next = steps.find((step) => step.step_number > enrolment.current_step);

  if (!next) {
    await service
      .from('lead_outreach')
      .update({ status: 'completed', next_step_at: null, stopped_at: now.toISOString() })
      .eq('id', enrolment.id);
    result.completed += 1;
    return;
  }

  await service
    .from('lead_outreach')
    .update({
      next_step_at: new Date(now.getTime() + next.delay_minutes * 60_000).toISOString()
    })
    .eq('id', enrolment.id);
}

/**
 * Send one step for one enrolment.
 *
 * Returns the outcome so the caller can count it. Everything that could stop a
 * send writes a `skipped` row first — the ledger is the audit trail, and a
 * decision that leaves no trace cannot be reviewed.
 */
async function processEnrolment(
  deps: EngineDeps,
  enrolment: DueEnrolment,
  settings: OutreachSettings,
  counters: { sentToday: number; sentThisRun: number },
  result: RunResult
): Promise<void> {
  const { service } = deps;
  const now = deps.now ?? new Date();

  const { data: stepRows } = await service
    .from('outreach_steps')
    .select('*')
    .eq('sequence_id', enrolment.sequence_id)
    .eq('active', true)
    .order('step_number', { ascending: true });

  const steps = ((stepRows ?? []) as unknown as Step[]).filter((step) => step.active);
  const step = steps.find((candidate) => candidate.step_number > enrolment.current_step);

  if (!step) {
    await advance(service, enrolment, steps, now, result);
    return;
  }

  const { data: leadRow } = await service
    .from('crm_leads')
    .select('id, pipeline_stage')
    .eq('id', enrolment.crm_lead_id)
    .maybeSingle();
  const lead = leadRow as { id: string; pipeline_stage: PipelineStage } | null;
  if (!lead) return;

  const { data: intelRow } = await service
    .from('lead_intelligence')
    .select('*')
    .eq('crm_lead_id', enrolment.crm_lead_id)
    .maybeSingle();
  const intelligence = intelRow as Record<string, unknown> | null;

  let contact: Record<string, unknown> | null = null;
  if (enrolment.contact_id) {
    const { data } = await service
      .from('contacts')
      .select('*')
      .eq('id', enrolment.contact_id)
      .maybeSingle();
    contact = data as Record<string, unknown> | null;
  }

  const toEmail =
    ((contact?.email as string) || (intelligence?.business_email as string) || null) ?? null;
  const toPhone =
    ((contact?.phone as string) || (intelligence?.business_phone as string) || null) ?? null;

  // The consent check, on the send path rather than as a list filter.
  const { data: suppressed } = await service.rpc('crm_is_suppressed', {
    p_email: toEmail,
    p_phone: toPhone
  });

  const base = {
    lead_outreach_id: enrolment.id,
    crm_lead_id: enrolment.crm_lead_id,
    contact_id: enrolment.contact_id,
    step_id: step.id,
    step_number: step.step_number,
    channel: step.channel,
    to_email: toEmail,
    to_phone: toPhone
  };

  async function recordSkip(reason: string): Promise<void> {
    await service.from('outreach_messages').insert({
      ...base,
      status: 'skipped',
      skip_reason: reason
    });
    result.skipped += 1;
    result.reasons.push(reason);
  }

  // ---- a call step is work for a person, not something to send -------------
  if (step.channel === 'call' || step.channel === 'linkedin' || step.channel === 'other') {
    await service.from('tasks').insert({
      crm_lead_id: enrolment.crm_lead_id,
      title: step.task_title ?? `${step.channel === 'call' ? 'Call' : 'Follow up with'} this lead`,
      description: step.body_template,
      due_at: now.toISOString(),
      priority: 'normal'
    });
    await service.from('outreach_messages').insert({
      ...base,
      status: 'skipped',
      skip_reason: 'Manual step — a task was created for a person to do it.'
    });
    result.tasksCreated += 1;
    await service
      .from('lead_outreach')
      .update({ current_step: step.step_number })
      .eq('id', enrolment.id);
    await advance(service, { ...enrolment, current_step: step.step_number }, steps, now, result);
    return;
  }

  // ---- gates ---------------------------------------------------------------
  const reason = blockedReason(
    {
      channel: step.channel,
      leadStage: lead.pipeline_stage,
      toEmail,
      toPhone,
      suppressed: Boolean(suppressed),
      ignoreSendWindow: step.ignore_send_window
    },
    { settings, now, sentToday: counters.sentToday, sentThisRun: counters.sentThisRun }
  );

  if (reason) {
    if (isTransientBlock(reason)) {
      // Leave the enrolment exactly where it is: the cap resets, the window
      // reopens, and it goes out on the next run.
      result.skipped += 1;
      result.reasons.push(reason);
      return;
    }
    await recordSkip(reason);
    // A settled objection stops the sequence rather than retrying forever.
    await service
      .from('lead_outreach')
      .update({
        status: 'stopped',
        stopped_at: now.toISOString(),
        stop_reason: reason,
        next_step_at: null
      })
      .eq('id', enrolment.id);
    return;
  }

  // ---- render --------------------------------------------------------------
  const context = buildContext(intelligence, contact, settings.from_name);
  const link = unsubscribeUrl(deps.siteUrl, enrolment.unsubscribe_token);

  let subject: string | null = null;
  let body: string;
  try {
    subject = step.subject_template ? render(step.subject_template, context) : null;
    body = render(step.body_template ?? '', context);
  } catch (error) {
    if (error instanceof TemplateError) {
      await recordSkip(error.message);
      await service
        .from('lead_outreach')
        .update({
          status: 'stopped',
          stopped_at: now.toISOString(),
          stop_reason: error.message,
          next_step_at: null,
          last_error: error.message
        })
        .eq('id', enrolment.id);
      return;
    }
    throw error;
  }

  // ---- claim the step ------------------------------------------------------
  // Insert before sending. The unique index on (lead_outreach_id, step_id) is
  // what stops two overlapping runs both emailing this person; losing the race
  // here means the other run has it.
  const { data: claimed, error: claimError } = await service
    .from('outreach_messages')
    .insert({
      ...base,
      status: 'queued',
      subject,
      body: step.channel === 'email' ? body + emailFooter({
        unsubscribeUrl: link,
        postalAddress: settings.postal_address,
        senderName: settings.from_name
      }) : body,
      from_email: step.channel === 'email' ? settings.from_email : null,
      from_phone: step.channel === 'sms' ? settings.sms_from_number : null
    })
    .select('id, body')
    .maybeSingle();

  if (claimError) {
    if (/duplicate key/i.test(claimError.message)) return; // another run has it
    throw new Error(`Could not queue the message: ${claimError.message}`);
  }
  const queued = claimed as { id: string; body: string } | null;
  if (!queued) return;

  // ---- send ----------------------------------------------------------------
  try {
    let providerMessageId: string | null = null;
    let provider = '';

    if (step.channel === 'email') {
      if (!deps.email) throw new Error('No email provider is configured.');
      const sent = await deps.email.send(
        {
          to: toEmail as string,
          from: settings.from_email as string,
          fromName: settings.from_name,
          replyTo: settings.reply_to_email,
          subject: subject ?? '(no subject)',
          text: queued.body,
          html: textToHtml(queued.body, link),
          // One-click unsubscribe, honoured by Gmail and Outlook without the
          // recipient having to find the link in the footer.
          headers: { 'List-Unsubscribe': `<${link}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }
        },
        deps.transport
      );
      providerMessageId = sent.providerMessageId;
      provider = sent.provider;
    } else {
      if (!deps.sms) throw new Error('No SMS provider is configured.');
      const sent = await deps.sms.send(
        {
          to: toPhone as string,
          from: settings.sms_from_number as string,
          // Every text says how to stop. There is no footer on an SMS.
          text: `${queued.body}\n\nReply STOP to opt out.`
        },
        deps.transport
      );
      providerMessageId = sent.providerMessageId;
      provider = sent.provider;
    }

    await service
      .from('outreach_messages')
      .update({
        status: 'sent',
        provider,
        provider_message_id: providerMessageId,
        sent_at: now.toISOString()
      })
      .eq('id', queued.id);

    // The timeline entry. `outbound`, so it cannot trip the inbound-reply
    // trigger and claim the lead answered.
    await service.from('activities').insert({
      crm_lead_id: enrolment.crm_lead_id,
      contact_id: enrolment.contact_id,
      type: step.channel === 'email' ? 'email' : 'sms',
      direction: 'outbound',
      subject: subject ?? `Outreach step ${step.step_number}`,
      body: queued.body,
      occurred_at: now.toISOString(),
      metadata: { workflow: 'outreach', step_number: step.step_number, sequence_id: enrolment.sequence_id }
    });

    await service
      .from('lead_outreach')
      .update({
        status: 'active',
        current_step: step.step_number,
        started_at: enrolment.current_step === 0 ? now.toISOString() : undefined,
        last_sent_at: now.toISOString(),
        last_error: null
      })
      .eq('id', enrolment.id);

    // Move the lead to `contacted` on the first message out. Forward-only, so
    // it never drags a lead back from a later stage.
    if (['qualified', 'ready_for_outreach'].includes(lead.pipeline_stage)) {
      await service
        .from('crm_leads')
        .update({ pipeline_stage: 'contacted' })
        .eq('id', enrolment.crm_lead_id);
    }

    counters.sentToday += 1;
    counters.sentThisRun += 1;
    result.sent += 1;

    await advance(service, { ...enrolment, current_step: step.step_number }, steps, now, result);
  } catch (error) {
    const detail = message(error);
    const retryable = error instanceof ProviderError ? error.retryable : false;

    await service
      .from('outreach_messages')
      .update({ status: 'failed', error: detail })
      .eq('id', queued.id);

    await service
      .from('lead_outreach')
      .update(
        retryable
          ? { last_error: detail, next_step_at: new Date(now.getTime() + 30 * 60_000).toISOString() }
          : {
              status: 'stopped',
              stopped_at: now.toISOString(),
              stop_reason: detail,
              next_step_at: null,
              last_error: detail
            }
      )
      .eq('id', enrolment.id);

    result.failed += 1;
    result.reasons.push(detail);
  }
}

/**
 * One pass of the engine.
 *
 * Returns without touching anything when sending is switched off, so pointing a
 * cron job at this on a fresh install does nothing until somebody decides
 * otherwise.
 */
export async function runOutreach(deps: EngineDeps): Promise<RunResult> {
  const result = emptyRun();
  const now = deps.now ?? new Date();
  const settings = await readSettings(deps.service);

  if (!settings.sending_enabled) {
    result.reasons.push('Sending is switched off in outreach settings.');
    return result;
  }

  const { data, error } = await deps.service
    .from('lead_outreach')
    .select('id, crm_lead_id, sequence_id, contact_id, current_step, unsubscribe_token')
    .eq('status', 'active')
    .lte('next_step_at', now.toISOString())
    .order('next_step_at', { ascending: true })
    .limit(settings.per_run_limit * 2);
  if (error) throw new Error(`Could not read due enrolments: ${error.message}`);

  const due = (data ?? []) as unknown as DueEnrolment[];
  result.considered = due.length;

  const counters = { sentToday: await sentToday(deps.service, now), sentThisRun: 0 };

  for (const enrolment of due) {
    if (counters.sentThisRun >= settings.per_run_limit) break;
    await processEnrolment(deps, enrolment, settings, counters, result);
  }

  return result;
}

/**
 * The rules that decide whether a message may go out.
 *
 * Pure, and separated from the engine on purpose: this is the part where a
 * mistake means contacting somebody who asked not to be contacted, and it
 * should be readable and testable on its own rather than buried in a loop that
 * also does HTTP.
 *
 * Every gate returns a reason string rather than a boolean, because "why did
 * this lead never get step 3" is the question the send ledger has to answer.
 */

import type { PipelineStage } from '@/lib/crm/types';

export interface OutreachSettings {
  sending_enabled: boolean;
  from_name: string | null;
  from_email: string | null;
  reply_to_email: string | null;
  sms_from_number: string | null;
  postal_address: string | null;
  daily_send_limit: number;
  per_run_limit: number;
  min_seconds_between_sends: number;
  send_window_start: number;
  send_window_end: number;
  send_on_weekends: boolean;
  timezone: string;
}

/** Lead stages that must never receive outreach, whatever a sequence says. */
export const NEVER_CONTACT_STAGES: PipelineStage[] = ['do_not_contact', 'lost', 'disqualified', 'won'];

/**
 * Is `when` inside the configured sending window?
 *
 * Evaluated in the configured zone, not the server's. A UK agency's business
 * hours do not move because the deployment region did.
 */
export function withinSendWindow(when: Date, settings: OutreachSettings): boolean {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: settings.timezone,
    hour12: false,
    weekday: 'short',
    hour: '2-digit'
  }).formatToParts(when);

  const weekday = parts.find((part) => part.type === 'weekday')?.value ?? '';
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? '0');

  if (!settings.send_on_weekends && (weekday === 'Sat' || weekday === 'Sun')) return false;
  // `hour` is the hour it is now, so the window is [start, end) — a window
  // ending at 17 stops at 16:59, not 17:59.
  return hour >= settings.send_window_start && hour < settings.send_window_end;
}

export interface SendCandidate {
  channel: string;
  leadStage: PipelineStage;
  toEmail: string | null;
  toPhone: string | null;
  suppressed: boolean;
  ignoreSendWindow: boolean;
}

export interface GateContext {
  settings: OutreachSettings;
  now: Date;
  /** Sends already recorded today, against the daily limit. */
  sentToday: number;
  /** Sends made in this run, against the per-run limit. */
  sentThisRun: number;
}

/**
 * Why this message may not be sent, or null if it may.
 *
 * Ordered by how fundamental the objection is: a global stop before a per-lead
 * one, and consent before convenience. The first reason returned is the one
 * worth recording.
 */
export function blockedReason(
  candidate: SendCandidate,
  context: GateContext
): string | null {
  const { settings } = context;

  if (!settings.sending_enabled) {
    return 'Sending is switched off in outreach settings.';
  }

  // Consent, before anything else. A suppressed address is not a scheduling
  // problem to be retried later — it is a person who said no.
  if (candidate.suppressed) {
    return 'This address is on the do-not-contact list.';
  }

  if (NEVER_CONTACT_STAGES.includes(candidate.leadStage)) {
    return `The lead is ${candidate.leadStage.replace(/_/g, ' ')}, so outreach does not apply.`;
  }

  if (candidate.channel === 'email') {
    if (!candidate.toEmail) return 'No email address for this lead.';
    if (!settings.from_email) return 'No sending address is configured in outreach settings.';
  }
  if (candidate.channel === 'sms') {
    if (!candidate.toPhone) return 'No mobile number for this lead.';
    if (!settings.sms_from_number) return 'No SMS sending number is configured.';
  }

  if (context.sentThisRun >= settings.per_run_limit) {
    return `This run has already sent its limit of ${settings.per_run_limit}.`;
  }
  if (context.sentToday >= settings.daily_send_limit) {
    return `Today's limit of ${settings.daily_send_limit} has been reached.`;
  }

  if (!candidate.ignoreSendWindow && !withinSendWindow(context.now, settings)) {
    return 'Outside the sending window.';
  }

  return null;
}

/**
 * Is a blocked send worth trying again later, or is it settled?
 *
 * A cap or a closed window clears by itself, so the enrolment keeps its place
 * in the queue. Consent and a missing address do not, and retrying them every
 * run forever fills the ledger with noise.
 */
export function isTransientBlock(reason: string): boolean {
  return (
    reason.includes('limit') ||
    reason.includes('sending window') ||
    reason.includes('switched off')
  );
}

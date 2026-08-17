/**
 * Reads for the outreach console, through the caller's session.
 *
 * `outreach_messages`, `inbound_messages` and `suppressions` are readable by
 * any member; only the first two are unwritable by everyone. RLS decides, so a
 * page that forgets a filter still cannot leak.
 */

import 'server-only';

import type { CrmSupabaseClient } from '@/lib/crm/supabase';
import type { IsoTimestamp, Uuid } from '@/lib/crm/types';

import type { OutreachSettings } from './gate';

export interface SuppressionRecord {
  id: Uuid;
  email: string | null;
  phone: string | null;
  reason: 'unsubscribed' | 'bounced' | 'complained' | 'manual' | 'invalid';
  source: string | null;
  notes: string | null;
  crm_lead_id: Uuid | null;
  created_at: IsoTimestamp;
}

export interface OutreachMessageRecord {
  id: Uuid;
  crm_lead_id: Uuid | null;
  lead_outreach_id: Uuid | null;
  step_number: number | null;
  channel: string;
  status: string;
  to_email: string | null;
  to_phone: string | null;
  subject: string | null;
  body: string | null;
  error: string | null;
  skip_reason: string | null;
  sent_at: IsoTimestamp | null;
  created_at: IsoTimestamp;
}

export interface EnrolmentRecord {
  id: Uuid;
  crm_lead_id: Uuid;
  sequence_id: Uuid;
  contact_id: Uuid | null;
  status: string;
  current_step: number;
  next_step_at: IsoTimestamp | null;
  started_at: IsoTimestamp | null;
  stopped_at: IsoTimestamp | null;
  stop_reason: string | null;
  last_error: string | null;
  last_sent_at: IsoTimestamp | null;
}

export async function getOutreachSettings(
  client: CrmSupabaseClient
): Promise<OutreachSettings | null> {
  const { data, error } = await client.from('outreach_settings').select('*').eq('id', true).maybeSingle();
  if (error) throw new Error(`Could not read outreach settings: ${error.message}`);
  return (data as unknown as OutreachSettings | null) ?? null;
}

export async function listSuppressions(
  client: CrmSupabaseClient,
  limit = 200
): Promise<SuppressionRecord[]> {
  const { data, error } = await client
    .from('suppressions')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`Could not read the do-not-contact list: ${error.message}`);
  return (data ?? []) as SuppressionRecord[];
}

export async function listEnrolments(
  client: CrmSupabaseClient,
  limit = 200
): Promise<EnrolmentRecord[]> {
  const { data, error } = await client
    .from('lead_outreach')
    .select('*')
    .order('updated_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`Could not read enrolments: ${error.message}`);
  return (data ?? []) as EnrolmentRecord[];
}

export async function listOutreachMessages(
  client: CrmSupabaseClient,
  limit = 100
): Promise<OutreachMessageRecord[]> {
  const { data, error } = await client
    .from('outreach_messages')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`Could not read the send log: ${error.message}`);
  return (data ?? []) as OutreachMessageRecord[];
}

export async function listMessagesForLead(
  client: CrmSupabaseClient,
  leadId: string
): Promise<OutreachMessageRecord[]> {
  const { data, error } = await client
    .from('outreach_messages')
    .select('*')
    .eq('crm_lead_id', leadId)
    .order('created_at', { ascending: false });
  if (error) throw new Error(`Could not read the send log: ${error.message}`);
  return (data ?? []) as OutreachMessageRecord[];
}

/**
 * How many messages went out today.
 *
 * Shown next to the daily cap, because "why has nothing sent since lunchtime"
 * is almost always this.
 */
export async function sentTodayCount(client: CrmSupabaseClient): Promise<number> {
  const now = new Date();
  const startOfDay = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  ).toISOString();

  const { data, error } = await client
    .from('outreach_messages')
    .select('id')
    .gte('sent_at', startOfDay)
    .limit(5000);
  if (error) throw new Error(`Could not count today's sends: ${error.message}`);
  return (data ?? []).length;
}

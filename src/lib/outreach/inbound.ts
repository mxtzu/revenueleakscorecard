/**
 * Everything that comes back: replies, opt-outs and delivery events.
 *
 * Reply detection deliberately does *not* stop sequences itself. It writes an
 * inbound activity, and `halt_outreach_on_inbound_reply` — the trigger from the
 * very first migration — stops every live enrolment for that lead and advances
 * the lead to `replied`. One implementation of that rule, in the database,
 * holding however the reply arrived.
 *
 * Matching a reply to a lead is by address, and an unmatched reply is stored
 * rather than dropped. A message from a stranger is still evidence that
 * somebody answered something.
 */

import type { CrmSupabaseClient } from '@/lib/crm/supabase';

import { detectOptOut, stripQuotedReply } from './templates';

export interface InboundMessage {
  channel: 'email' | 'sms';
  fromEmail?: string | null;
  fromPhone?: string | null;
  toEmail?: string | null;
  toPhone?: string | null;
  subject?: string | null;
  body: string;
  provider: string;
  providerMessageId?: string | null;
  inReplyTo?: string | null;
  receivedAt?: string;
}

export interface InboundOutcome {
  status: 'recorded' | 'duplicate' | 'unmatched';
  leadId: string | null;
  optedOut: boolean;
  detail: string;
}

function normaliseEmail(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim().toLowerCase();
  return trimmed || null;
}

function normalisePhone(value: string | null | undefined): string | null {
  const digits = (value ?? '').replace(/[^0-9+]/g, '');
  return digits || null;
}

/**
 * Find the lead a reply belongs to.
 *
 * Contacts first, because a reply from a named person is the strongest signal
 * and the CRM's own record of who that is. Then the lead's published business
 * address from the pipeline. Then, for SMS especially, the most recent message
 * actually sent to that address — which catches a reply from an inbox the CRM
 * has never seen listed anywhere.
 */
export async function matchLead(
  service: CrmSupabaseClient,
  inbound: InboundMessage
): Promise<{ leadId: string | null; contactId: string | null }> {
  const email = normaliseEmail(inbound.fromEmail);
  const phone = normalisePhone(inbound.fromPhone);

  if (email) {
    const { data } = await service
      .from('contacts')
      .select('id, crm_lead_id')
      .ilike('email', email)
      .limit(1);
    const contact = ((data ?? [])[0] ?? null) as { id: string; crm_lead_id: string } | null;
    if (contact) return { leadId: contact.crm_lead_id, contactId: contact.id };
  }

  if (phone) {
    const { data } = await service.from('contacts').select('id, crm_lead_id, phone').limit(1000);
    const contact = ((data ?? []) as { id: string; crm_lead_id: string; phone: string | null }[])
      .find((row) => normalisePhone(row.phone) === phone);
    if (contact) return { leadId: contact.crm_lead_id, contactId: contact.id };
  }

  if (email) {
    const { data } = await service
      .from('lead_intelligence')
      .select('crm_lead_id')
      .ilike('business_email', email)
      .limit(1);
    const intel = ((data ?? [])[0] ?? null) as { crm_lead_id: string } | null;
    if (intel) return { leadId: intel.crm_lead_id, contactId: null };
  }

  // Last resort: whoever we last sent to at this address.
  const lookup = service
    .from('outreach_messages')
    .select('crm_lead_id, contact_id')
    .order('created_at', { ascending: false })
    .limit(1);
  const { data } = email
    ? await lookup.ilike('to_email', email)
    : phone
      ? await lookup.eq('to_phone', phone)
      : { data: null };
  const sent = ((data ?? [])[0] ?? null) as
    | { crm_lead_id: string | null; contact_id: string | null }
    | null;
  if (sent?.crm_lead_id) return { leadId: sent.crm_lead_id, contactId: sent.contact_id };

  return { leadId: null, contactId: null };
}

/**
 * Record an inbound message and act on it.
 *
 * Order matters: the suppression is written before the activity. If the process
 * died between the two, the worse outcome by far is having recorded a reply and
 * not the opt-out that came with it.
 */
export async function recordInbound(
  service: CrmSupabaseClient,
  inbound: InboundMessage
): Promise<InboundOutcome> {
  const optedOut = detectOptOut(inbound.body);
  const { leadId, contactId } = await matchLead(service, inbound);

  const email = normaliseEmail(inbound.fromEmail);
  const phone = normalisePhone(inbound.fromPhone);

  if (optedOut && (email || phone)) {
    // Ignore a conflict: already suppressed is the state we wanted.
    await service.from('suppressions').insert({
      email,
      phone,
      reason: 'unsubscribed',
      source: `${inbound.provider} ${inbound.channel} reply`,
      crm_lead_id: leadId,
      notes: stripQuotedReply(inbound.body).trim().slice(0, 500)
    });
  }

  const { data, error } = await service
    .from('inbound_messages')
    .insert({
      crm_lead_id: leadId,
      contact_id: contactId,
      channel: inbound.channel,
      from_email: email,
      from_phone: phone,
      to_email: normaliseEmail(inbound.toEmail),
      to_phone: normalisePhone(inbound.toPhone),
      subject: inbound.subject ?? null,
      body: inbound.body,
      provider: inbound.provider,
      provider_message_id: inbound.providerMessageId ?? null,
      in_reply_to: inbound.inReplyTo ?? null,
      is_opt_out: optedOut,
      received_at: inbound.receivedAt ?? new Date().toISOString()
    })
    .select('id')
    .maybeSingle();

  if (error) {
    if (/duplicate key/i.test(error.message)) {
      return { status: 'duplicate', leadId, optedOut, detail: 'Already recorded.' };
    }
    throw new Error(`Could not record the inbound message: ${error.message}`);
  }

  if (!leadId) {
    return {
      status: 'unmatched',
      leadId: null,
      optedOut,
      detail: `Reply from ${email ?? phone ?? 'an unknown sender'} did not match a lead.`
    };
  }

  // The activity is what stops the sequence: `halt_outreach_on_inbound_reply`
  // fires on this insert. Nothing here calls the stop logic directly.
  const { error: activityError } = await service.from('activities').insert({
    crm_lead_id: leadId,
    contact_id: contactId,
    type: inbound.channel,
    direction: 'inbound',
    subject: inbound.subject ?? `${inbound.channel === 'sms' ? 'Text' : 'Email'} reply`,
    body: inbound.body,
    occurred_at: inbound.receivedAt ?? new Date().toISOString(),
    metadata: { workflow: 'outreach_reply', opted_out: optedOut, provider: inbound.provider }
  });
  if (activityError) {
    throw new Error(`Could not add the reply to the timeline: ${activityError.message}`);
  }

  await service
    .from('inbound_messages')
    .update({ processed_at: new Date().toISOString() })
    .eq('id', (data as { id: string }).id);

  return {
    status: 'recorded',
    leadId,
    optedOut,
    detail: optedOut
      ? 'Reply recorded as an opt-out; the address is now suppressed.'
      : 'Reply recorded; live sequences for this lead have stopped.'
  };
}

// ---------------------------------------------------------------------------
// Delivery events
// ---------------------------------------------------------------------------

/** Provider event names mapped onto the CRM's message statuses. */
const EVENT_STATUS: Record<string, string> = {
  'email.sent': 'sent',
  'email.delivered': 'delivered',
  'email.opened': 'opened',
  'email.clicked': 'clicked',
  'email.bounced': 'bounced',
  'email.complained': 'complained',
  'email.delivery_delayed': 'sent'
};

const STATUS_COLUMN: Record<string, string> = {
  delivered: 'delivered_at',
  opened: 'opened_at',
  clicked: 'clicked_at',
  bounced: 'bounced_at',
  complained: 'complained_at'
};

/**
 * Apply a delivery event to the send ledger.
 *
 * A bounce or a complaint also suppresses the address. That is the whole point
 * of tracking them: continuing to mail an address that hard-bounced is how a
 * sending domain gets blocked, and continuing after a spam complaint is how it
 * gets blocked permanently.
 */
export async function recordDeliveryEvent(
  service: CrmSupabaseClient,
  event: { type: string; providerMessageId: string; provider: string; recipient?: string | null; at?: string }
): Promise<{ applied: boolean; detail: string }> {
  const status = EVENT_STATUS[event.type];
  if (!status) return { applied: false, detail: `No handler for ${event.type}.` };

  const { data } = await service
    .from('outreach_messages')
    .select('id, to_email, crm_lead_id, last_event_at')
    .eq('provider', event.provider)
    .eq('provider_message_id', event.providerMessageId)
    .maybeSingle();

  const row = data as
    | { id: string; to_email: string | null; crm_lead_id: string | null; last_event_at: string | null }
    | null;
  if (!row) return { applied: false, detail: 'No matching message in the ledger.' };

  const at = event.at ?? new Date().toISOString();
  const column = STATUS_COLUMN[status];

  await service
    .from('outreach_messages')
    .update({
      status,
      last_event_at: at,
      ...(column ? { [column]: at } : {})
    })
    .eq('id', row.id);

  if (status === 'bounced' || status === 'complained') {
    const address = event.recipient ?? row.to_email;
    if (address) {
      await service.from('suppressions').insert({
        email: address,
        reason: status === 'bounced' ? 'bounced' : 'complained',
        source: `${event.provider} ${event.type}`,
        crm_lead_id: row.crm_lead_id
      });
    }
  }

  return { applied: true, detail: `Marked ${status}.` };
}

/** Claim a provider event, or report it as already handled. */
export async function claimProviderEvent(
  service: CrmSupabaseClient,
  provider: string,
  eventId: string,
  type: string
): Promise<boolean> {
  const { error } = await service.from('provider_events').insert({
    id: `${provider}:${eventId}`,
    provider,
    type,
    status: 'received'
  });
  if (!error) return true;
  if (/duplicate key|already exists/i.test(error.message)) return false;
  throw new Error(`Could not record the provider event: ${error.message}`);
}

/**
 * Two-way sync between `appointments` and one Google calendar.
 *
 * A run does three things, in this order and for a reason:
 *
 *   1. drain deletions — an appointment deleted here should disappear from the
 *      calendar before anything else re-imports it,
 *   2. push pending   — local edits go out before remote state is read, so the
 *      pull sees the calendar as it now is,
 *   3. pull changes   — incremental where possible, full when Google expires
 *      the cursor.
 *
 * Runs as the service role. It has to: `calendar_credentials` is readable by
 * nothing else. That means RLS is not protecting the appointment writes here,
 * so every query is scoped explicitly to `calendar_account_id`, which is the
 * boundary between one person's diary and another's.
 *
 * Conflicts are resolved by comparing timestamps, and ties go to the CRM. See
 * `remoteIsNewer` in mapping.ts.
 */

import { randomUUID } from 'node:crypto';

import type { CrmSupabaseClient } from '@/lib/crm/supabase';
import type { Appointment } from '@/lib/crm/types';

import { GoogleApiError, type Transport } from './http';
import {
  conferenceUrl,
  deleteEvent,
  insertEvent,
  listEvents,
  patchEvent,
  stopChannel,
  watchCalendar,
  type CalendarRequestContext,
  type SendUpdates
} from './googleCalendar';
import {
  appointmentIdOf,
  appointmentToEvent,
  crmStatusFor,
  eventToAppointment,
  pushResultOf,
  remoteIsNewer
} from './mapping';
import { accessTokenFor, CalendarAuthError } from './tokens';
import { channelToken } from './webhookAuth';
import type { CalendarAccount, CalendarDeletion, SyncSummary } from './types';
import { emptySummary } from './types';

/** Cap on pages per run, so one enormous calendar cannot hang a request. */
const MAX_PAGES = 20;
/** How far back a full resync looks. Older meetings are history, not schedule. */
const FULL_SYNC_WINDOW_DAYS = 30;
/** Give up on a deletion after this many failures rather than retrying forever. */
const MAX_DELETION_ATTEMPTS = 5;

export interface SyncContext {
  service: CrmSupabaseClient;
  account: CalendarAccount;
  accessToken: string;
  transport?: Transport;
}

function requestContext(ctx: SyncContext): CalendarRequestContext {
  return {
    accessToken: ctx.accessToken,
    calendarId: ctx.account.calendar_id,
    transport: ctx.transport
  };
}

/**
 * Whether Google should email the attendees of this appointment.
 *
 * Off unless a human explicitly ticked the box on that appointment. The CRM
 * does not contact people on its own, and an attendee list plus a default of
 * `all` would turn every sync into an outbound mailing.
 */
function sendUpdatesFor(appointment: Pick<Appointment, 'notify_attendees'>): SendUpdates {
  return appointment.notify_attendees ? 'all' : 'none';
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// 1. Deletions
// ---------------------------------------------------------------------------

/**
 * Remove events whose appointments are already gone.
 *
 * The rows come from the outbox a trigger fills on delete, because by now the
 * appointment — and its `external_event_id` — no longer exists.
 */
export async function drainDeletions(ctx: SyncContext, summary: SyncSummary): Promise<void> {
  const { data, error } = await ctx.service
    .from('calendar_deletions')
    .select('*')
    .eq('calendar_account_id', ctx.account.id)
    .lt('attempts', MAX_DELETION_ATTEMPTS)
    .limit(100);
  if (error) throw new Error(`Could not read pending deletions: ${error.message}`);

  for (const row of (data ?? []) as CalendarDeletion[]) {
    try {
      await deleteEvent(
        { ...requestContext(ctx), calendarId: row.calendar_id },
        row.external_event_id,
        // The appointment is gone and the cancellation notice, if one was
        // wanted, is not something a background job should decide to send.
        { sendUpdates: 'none' }
      );
      await ctx.service.from('calendar_deletions').delete().eq('id', row.id);
      summary.deleted += 1;
    } catch (error) {
      summary.failed += 1;
      summary.errors.push(`delete ${row.external_event_id}: ${message(error)}`);
      await ctx.service
        .from('calendar_deletions')
        .update({ attempts: row.attempts + 1, last_error: message(error) })
        .eq('id', row.id);
    }
  }
}

// ---------------------------------------------------------------------------
// 2. Push
// ---------------------------------------------------------------------------

/** Send one appointment to Google and write back what came home. */
export async function pushAppointment(
  ctx: SyncContext,
  appointment: Appointment
): Promise<void> {
  const { event, withConference } = appointmentToEvent(appointment);
  const options = { sendUpdates: sendUpdatesFor(appointment), withConference };

  const saved = appointment.external_event_id
    ? await patchEvent(requestContext(ctx), appointment.external_event_id, event, options)
    : await insertEvent(requestContext(ctx), event, options);

  const result = pushResultOf(saved, appointment.google_meet_url);

  const { error } = await ctx.service
    .from('appointments')
    .update({
      ...result,
      calendar_account_id: ctx.account.id,
      sync_state: 'synced',
      sync_error: null,
      synced_at: new Date().toISOString()
    })
    .eq('id', appointment.id);
  if (error) throw new Error(`Could not record the sync: ${error.message}`);
}

export async function pushPending(ctx: SyncContext, summary: SyncSummary): Promise<void> {
  const { data, error } = await ctx.service
    .from('appointments')
    .select('*')
    .eq('calendar_account_id', ctx.account.id)
    .in('sync_state', ['pending', 'failed'])
    .order('starts_at', { ascending: true })
    .limit(100);
  if (error) throw new Error(`Could not read appointments to push: ${error.message}`);

  for (const appointment of (data ?? []) as Appointment[]) {
    try {
      await pushAppointment(ctx, appointment);
      summary.pushed += 1;
    } catch (error) {
      // An auth failure is not this appointment's fault and will fail for every
      // other one too, so it stops the run rather than marking a hundred rows
      // as broken.
      if (error instanceof CalendarAuthError) throw error;
      if (error instanceof GoogleApiError && error.isAuthFailure) throw error;

      summary.failed += 1;
      summary.errors.push(`push ${appointment.title}: ${message(error)}`);
      await ctx.service
        .from('appointments')
        .update({ sync_state: 'failed', sync_error: message(error) })
        .eq('id', appointment.id);
    }
  }
}

// ---------------------------------------------------------------------------
// 3. Pull
// ---------------------------------------------------------------------------

async function applyRemoteEvent(
  ctx: SyncContext,
  raw: Parameters<typeof eventToAppointment>[0],
  summary: SyncSummary
): Promise<void> {
  const pulled = eventToAppointment(raw, 'Europe/London');
  if (!pulled) return;

  // Prefer the id we stamped on the event when we created it: two calls booked
  // back to back look identical otherwise.
  const stampedId = appointmentIdOf(raw);

  const lookup = ctx.service.from('appointments').select('*').limit(1);
  const { data, error } = stampedId
    ? await lookup.eq('id', stampedId)
    : await lookup
        .eq('calendar_provider', 'google')
        .eq('external_event_id', pulled.external_event_id);
  if (error) throw new Error(`Could not match the calendar event: ${error.message}`);

  const existing = ((data ?? [])[0] ?? null) as Appointment | null;

  if (!existing) {
    // A tombstone for something we never had is not news.
    if (pulled.cancelled || !pulled.starts_at) return;

    const { error: insertError } = await ctx.service.from('appointments').insert({
      title: pulled.title,
      starts_at: pulled.starts_at,
      ends_at: pulled.ends_at,
      timezone: pulled.timezone,
      status: crmStatusFor(raw),
      created_by: ctx.account.profile_id,
      calendar_provider: 'google',
      calendar_account_id: ctx.account.id,
      external_event_id: pulled.external_event_id,
      external_html_link: pulled.external_html_link,
      external_updated_at: pulled.external_updated_at,
      google_meet_url: pulled.google_meet_url,
      attendee_emails: pulled.attendee_emails,
      sync_state: 'synced',
      synced_at: new Date().toISOString()
    });
    if (insertError) throw new Error(`Could not import the event: ${insertError.message}`);
    summary.created += 1;
    return;
  }

  if (pulled.cancelled) {
    // Always honoured, whatever the timestamps say: an event deleted in Google
    // is not coming back, and leaving it live in the CRM sends someone to a
    // meeting that is not happening.
    await ctx.service
      .from('appointments')
      .update({
        status: 'cancelled',
        sync_state: 'synced',
        sync_error: null,
        external_updated_at: pulled.external_updated_at,
        synced_at: new Date().toISOString()
      })
      .eq('id', existing.id);
    summary.cancelled += 1;
    return;
  }

  // Local edits that have not gone out yet win; they are about to be pushed.
  if (existing.sync_state === 'pending' || existing.sync_state === 'failed') return;
  if (!remoteIsNewer(pulled.external_updated_at, existing.updated_at)) {
    // Still worth recording the link when a push created the event but the
    // write-back did not land.
    if (!existing.external_event_id) {
      await ctx.service
        .from('appointments')
        .update({
          calendar_provider: 'google',
          calendar_account_id: ctx.account.id,
          external_event_id: pulled.external_event_id,
          external_html_link: pulled.external_html_link,
          google_meet_url: existing.google_meet_url ?? pulled.google_meet_url,
          sync_state: 'synced',
          synced_at: new Date().toISOString()
        })
        .eq('id', existing.id);
    }
    return;
  }

  const { error: updateError } = await ctx.service
    .from('appointments')
    .update({
      title: pulled.title,
      starts_at: pulled.starts_at,
      ends_at: pulled.ends_at,
      timezone: pulled.timezone,
      google_meet_url: pulled.google_meet_url ?? existing.google_meet_url,
      external_html_link: pulled.external_html_link,
      external_updated_at: pulled.external_updated_at,
      attendee_emails: pulled.attendee_emails,
      calendar_provider: 'google',
      calendar_account_id: ctx.account.id,
      external_event_id: pulled.external_event_id,
      sync_state: 'synced',
      sync_error: null,
      synced_at: new Date().toISOString()
    })
    .eq('id', existing.id);
  if (updateError) throw new Error(`Could not apply the calendar change: ${updateError.message}`);
  summary.pulled += 1;
}

/**
 * Read changes from Google.
 *
 * Uses the stored sync token when there is one. Google expires tokens and
 * answers 410 GONE; the only correct response is to discard the cursor and
 * pull the window again from scratch, which is what `fullResync` does. Getting
 * this wrong means a calendar that stops updating and never says so.
 */
export async function pullChanges(ctx: SyncContext, summary: SyncSummary): Promise<string | null> {
  const timeMin = new Date(Date.now() - FULL_SYNC_WINDOW_DAYS * 86_400_000).toISOString();

  async function run(syncToken: string | null): Promise<string | null> {
    let pageToken: string | null = null;
    let nextSyncToken: string | null = null;

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = await listEvents(requestContext(ctx), {
        syncToken,
        pageToken,
        timeMin
      });

      for (const event of result.items) {
        await applyRemoteEvent(ctx, event, summary);
      }

      nextSyncToken = result.nextSyncToken ?? nextSyncToken;
      pageToken = result.nextPageToken;
      if (!pageToken) break;
    }

    return nextSyncToken;
  }

  try {
    return await run(ctx.account.sync_token);
  } catch (error) {
    if (error instanceof GoogleApiError && error.isGone) {
      summary.fullResync = true;
      summary.errors.push('Google expired the sync cursor; pulled the whole window instead.');
      return await run(null);
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Push notifications (optional)
// ---------------------------------------------------------------------------

/** Renew a channel this long before Google expires it. */
const CHANNEL_RENEW_MARGIN_MS = 12 * 60 * 60 * 1000;

/**
 * Keep a push channel open, if this deployment is set up for one.
 *
 * Entirely optional. Google expires channels within a week and drops
 * notifications, so the poll is what actually guarantees the calendar
 * converges; a channel only makes it prompt. That is why every failure here is
 * swallowed into the summary rather than failing the run — losing the channel
 * must not lose the sync.
 *
 * Requires both a secret (to authenticate the callback) and a publicly
 * reachable URL, which localhost is not.
 */
export async function ensureChannel(ctx: SyncContext, summary: SyncSummary): Promise<void> {
  const secret = process.env.CALENDAR_WEBHOOK_SECRET;
  const base = process.env.CALENDAR_WEBHOOK_URL;
  if (!secret || !base) return;

  const expires = ctx.account.channel_expires_at;
  const healthy =
    ctx.account.channel_id &&
    expires &&
    new Date(expires).getTime() - CHANNEL_RENEW_MARGIN_MS > Date.now();
  if (healthy) return;

  try {
    // Close the old one first, or Google keeps delivering to both.
    if (ctx.account.channel_id && ctx.account.channel_resource_id) {
      await stopChannel(requestContext(ctx), {
        channelId: ctx.account.channel_id,
        resourceId: ctx.account.channel_resource_id
      });
    }

    const channelId = randomUUID();
    const opened = await watchCalendar(requestContext(ctx), {
      channelId,
      address: base,
      token: channelToken(channelId, secret)
    });

    await ctx.service
      .from('calendar_accounts')
      .update({
        channel_id: channelId,
        channel_resource_id: opened.resourceId,
        channel_expires_at: opened.expiration
      })
      .eq('id', ctx.account.id);
  } catch (error) {
    summary.errors.push(`push notifications unavailable: ${message(error)}`);
  }
}

// ---------------------------------------------------------------------------
// A whole run
// ---------------------------------------------------------------------------

/**
 * Sync one account, and record the outcome on it either way.
 *
 * The summary is written whether the run succeeded or failed, because a
 * calendar that has silently not synced for a fortnight looks exactly like a
 * calendar with nothing in it.
 */
export async function syncAccount(
  service: CrmSupabaseClient,
  account: CalendarAccount,
  options: { transport?: Transport } = {}
): Promise<SyncSummary> {
  const summary = emptySummary();

  if (!account.is_active) {
    summary.errors.push('The connection is not active. Reconnect the calendar.');
    return summary;
  }

  try {
    const accessToken = await accessTokenFor(service, account, { transport: options.transport });
    const ctx: SyncContext = { service, account, accessToken, transport: options.transport };

    await drainDeletions(ctx, summary);
    await pushPending(ctx, summary);
    const nextToken = await pullChanges(ctx, summary);
    await ensureChannel(ctx, summary);

    await service
      .from('calendar_accounts')
      .update({
        sync_token: nextToken ?? account.sync_token,
        last_synced_at: new Date().toISOString(),
        last_sync_summary: summary as unknown as Record<string, unknown>,
        last_error: summary.errors.length > 0 ? summary.errors[0] : null
      })
      .eq('id', account.id);
  } catch (error) {
    summary.errors.push(message(error));
    await service
      .from('calendar_accounts')
      .update({
        last_synced_at: new Date().toISOString(),
        last_sync_summary: summary as unknown as Record<string, unknown>,
        last_error: message(error)
      })
      .eq('id', account.id);
  }

  return summary;
}

export { CalendarAuthError };

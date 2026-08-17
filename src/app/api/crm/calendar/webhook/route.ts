/**
 * POST /api/crm/calendar/webhook — Google says something changed.
 *
 * Google's push notifications carry no event data at all: the body is empty
 * and everything is in the headers. The notification is only ever a nudge
 * meaning "call events.list again", which is exactly what this does.
 *
 * Authentication is the channel token, which Google echoes back in
 * `X-Goog-Channel-Token`. It was minted per channel when the watch was
 * created, so a stranger who guesses this URL cannot make the CRM do anything
 * — and the `X-Goog-Channel-ID` still has to match a stored account.
 *
 * Everything here is best-effort by design. Channels expire within a week and
 * notifications can be dropped, so the scheduled poll remains the thing that
 * guarantees the calendar converges; this only makes it prompt.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { syncAccount } from '@/lib/calendar/sync';
import type { CalendarAccount } from '@/lib/calendar/types';
import { createServiceClient, isCrmConfigured, isServiceRoleConfigured } from '@/lib/crm/supabase';
import { channelToken, tokenMatches } from '@/lib/calendar/webhookAuth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  // Always 200. Google retries on any error and disables a channel that keeps
  // failing, so a misconfigured deployment must not take the channel down with
  // it — the poll is the safety net either way.
  const ok = () => new NextResponse(null, { status: 200 });

  if (!isCrmConfigured() || !isServiceRoleConfigured()) return ok();

  const secret = process.env.CALENDAR_WEBHOOK_SECRET;
  if (!secret) return ok();

  const channelId = request.headers.get('x-goog-channel-id');
  const state = request.headers.get('x-goog-resource-state');
  if (!channelId) return ok();

  // `sync` is the handshake Google sends when the channel opens. Nothing has
  // changed yet, and syncing on it would be a wasted round trip per channel.
  if (state === 'sync') return ok();

  if (!tokenMatches(request.headers.get('x-goog-channel-token'), channelToken(channelId, secret))) {
    return ok();
  }

  const service = createServiceClient();
  const { data } = await service
    .from('calendar_accounts')
    .select('*')
    .eq('channel_id', channelId)
    .eq('is_active', true)
    .maybeSingle();
  if (!data) return ok();

  try {
    await syncAccount(service, data as CalendarAccount);
  } catch {
    // syncAccount already recorded the failure on the account row.
  }
  return ok();
}

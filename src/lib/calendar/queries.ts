/**
 * Reads for the calendar page, through the caller's session.
 *
 * Note what is *not* here: nothing reads `calendar_credentials`. It has no RLS
 * policy, so a session-scoped query against it returns nothing whatever the
 * caller's role — which is the point. Tokens are only ever touched by the
 * service-role client inside the sync and the OAuth callback.
 */

import 'server-only';

import type { CrmSupabaseClient } from '@/lib/crm/supabase';

import type { CalendarAccount } from './types';

export async function getCalendarAccount(
  client: CrmSupabaseClient,
  profileId: string
): Promise<CalendarAccount | null> {
  const { data, error } = await client
    .from('calendar_accounts')
    .select('*')
    .eq('profile_id', profileId)
    .maybeSingle();
  if (error) throw new Error(`Could not read the calendar connection: ${error.message}`);
  return (data as CalendarAccount | null) ?? null;
}

/** Every connection, for an admin. RLS returns only their own to anyone else. */
export async function listCalendarAccounts(
  client: CrmSupabaseClient
): Promise<CalendarAccount[]> {
  const { data, error } = await client
    .from('calendar_accounts')
    .select('*')
    .order('google_email', { ascending: true });
  if (error) throw new Error(`Could not read calendar connections: ${error.message}`);
  return (data ?? []) as CalendarAccount[];
}

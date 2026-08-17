'use server';

/**
 * Calendar actions: sync now, and disconnect.
 *
 * Connecting is not here — it is a redirect to Google, which a Server Action
 * cannot do usefully, so it lives at `/api/crm/calendar/connect`.
 *
 * Both of these need the service-role client, because both touch
 * `calendar_credentials`, which no session can read. That makes the ownership
 * check in each one load-bearing rather than decorative: RLS is not standing
 * behind it.
 */

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { openOptional } from '@/lib/calendar/crypto';
import { revokeToken } from '@/lib/calendar/oauth';
import { syncAccount } from '@/lib/calendar/sync';
import { readCredentials } from '@/lib/calendar/tokens';
import type { CalendarAccount } from '@/lib/calendar/types';
import { readableWriteError } from '@/lib/crm/errors';
import { requireWriter } from '@/lib/crm/server';
import { createServiceClient, isServiceRoleConfigured } from '@/lib/crm/supabase';
import { uuid } from '@/lib/crm/validation';

function back(message?: string, key: 'error' | 'notice' = 'error'): never {
  redirect(message ? `/calendar?${key}=${encodeURIComponent(message)}` : '/calendar');
}

/**
 * Load the account this action is allowed to act on.
 *
 * An admin may operate on anyone's connection; everybody else only on their
 * own. Checked here explicitly because the service-role client that follows
 * bypasses every policy.
 */
async function ownedAccount(accountId: string) {
  const { client, profile } = await requireWriter();
  const { data, error } = await client
    .from('calendar_accounts')
    .select('*')
    .eq('id', accountId)
    .maybeSingle();
  // This read goes through the session, so RLS has already filtered it: a row
  // coming back at all means the caller may see it.
  if (error) throw new Error(error.message);
  if (!data) throw new Error('That calendar connection no longer exists.');
  return { account: data as CalendarAccount, profile };
}

export async function syncCalendar(form: FormData) {
  let notice: string;
  try {
    if (!isServiceRoleConfigured()) {
      throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set, so the calendar cannot sync.');
    }
    const { account } = await ownedAccount(uuid(form, 'account_id', 'Calendar'));
    const summary = await syncAccount(createServiceClient(), account);

    const parts = [
      `${summary.pushed} sent`,
      `${summary.pulled + summary.created} received`,
      summary.cancelled ? `${summary.cancelled} cancelled` : null,
      summary.failed ? `${summary.failed} failed` : null
    ].filter(Boolean);
    notice =
      summary.errors.length > 0
        ? `Synced with problems: ${summary.errors[0]}`
        : `Synced — ${parts.join(', ')}.`;
  } catch (error) {
    back(readableWriteError(error));
  }
  revalidatePath('/calendar');
  back(notice, 'notice');
}

/**
 * Disconnect, and mean it.
 *
 * Deleting the row alone would leave the CRM listed in the user's Google
 * permissions with a refresh token that still works, so the grant is revoked
 * at Google first. Revocation failing does not block the disconnect — the
 * point is to stop this CRM holding the credential.
 */
export async function disconnectCalendar(form: FormData) {
  try {
    const { account } = await ownedAccount(uuid(form, 'account_id', 'Calendar'));

    if (isServiceRoleConfigured()) {
      const service = createServiceClient();
      try {
        const credentials = await readCredentials(service, account.id);
        const token = openOptional(credentials?.refresh_token_enc ?? credentials?.access_token_enc);
        if (token) await revokeToken(token);
      } catch {
        // Already revoked, expired, or unreadable with the current key. The
        // row is going either way.
      }
      // Deletes the credentials by cascade.
      const { error } = await service.from('calendar_accounts').delete().eq('id', account.id);
      if (error) throw new Error(error.message);
    } else {
      // No service key: the session can still delete its own row, and the
      // cascade takes the tokens with it.
      const { client } = await requireWriter();
      const { error } = await client.from('calendar_accounts').delete().eq('id', account.id);
      if (error) throw new Error(error.message);
    }
  } catch (error) {
    back(readableWriteError(error));
  }
  revalidatePath('/calendar');
  back('Calendar disconnected and access revoked at Google.', 'notice');
}

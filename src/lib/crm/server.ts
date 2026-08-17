/**
 * Server-only entry point for CRM pages.
 *
 * Every CRM page reads through `crmClient()`, which is bound to the request's
 * session cookie. That means RLS decides what each page can see — a page that
 * forgets a filter still cannot leak another tenant's rows, and a signed-out
 * visitor sees nothing at all.
 *
 * The service-role client is deliberately NOT re-exported here. It belongs to
 * the sync job and (later) the Stripe webhook, never to a rendered page.
 */

import 'server-only';
import { cookies } from 'next/headers';

import { createServerClient, isCrmConfigured, type CrmSupabaseClient } from './supabase';
import { assertCanWrite, isAdmin, PermissionError } from './permissions';
import { getCurrentProfile } from './queries';
import type { Profile } from './types';

export function crmClient(): CrmSupabaseClient {
  // next/headers' cookie store is structurally compatible: `get` returns
  // `{ value }` and `set` throws in a Server Component, which createServerClient
  // already swallows.
  return createServerClient(cookies() as unknown as Parameters<typeof createServerClient>[0]);
}

export interface CrmSession {
  client: CrmSupabaseClient;
  profile: Profile | null;
}

/**
 * Client plus the signed-in profile. `profile` is null when nobody is signed in
 * or the account has no profile row yet; pages render a sign-in prompt rather
 * than an empty dashboard so the difference is never ambiguous.
 */
export async function crmSession(): Promise<CrmSession> {
  const client = crmClient();
  return { client, profile: await getCurrentProfile(client) };
}

export { isCrmConfigured };

/**
 * A client for a caller whose role permits writing, plus their id.
 *
 * Every mutating server action starts here. The check is a courtesy — RLS
 * refuses the write regardless — but it turns a Postgres policy violation into
 * a sentence, and it re-reads the role at write time rather than trusting what
 * the page decided to render some minutes ago.
 */
export async function requireWriter(): Promise<{
  client: CrmSupabaseClient;
  profile: Profile | null;
  userId: string | null;
}> {
  const client = crmClient();
  const profile = await getCurrentProfile(client);
  assertCanWrite(profile);
  return { client, profile, userId: profile?.id ?? null };
}

/**
 * The same, for deletes.
 *
 * Deletion is admin-only in RLS (`crm_is_admin()`), unlike insert and update.
 * A destroyed record has no undo, so the narrower gate is deliberate and this
 * mirrors it rather than letting a writer discover the limit by hitting it.
 */
export async function requireAdmin(): Promise<{
  client: CrmSupabaseClient;
  userId: string | null;
}> {
  const client = crmClient();
  const profile = await getCurrentProfile(client);
  if (!isAdmin(profile)) {
    throw new PermissionError('Only an owner or admin can delete records.');
  }
  return { client, userId: profile?.id ?? null };
}

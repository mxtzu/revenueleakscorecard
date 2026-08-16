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

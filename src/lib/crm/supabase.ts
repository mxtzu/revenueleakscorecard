/**
 * Supabase clients for the CRM.
 *
 * Two, deliberately distinct:
 *
 *   createServerClient()  - request-scoped, carries the user's session cookie.
 *                           RLS applies. Use this for anything a logged-in
 *                           user reads or writes.
 *
 *   createServiceClient() - service role, bypasses RLS. Use ONLY for trusted
 *                           server-side jobs: the lead sync and (later) the
 *                           Stripe webhook. Never reachable from the browser.
 *
 * The service-role key is read from a non-NEXT_PUBLIC env var, so Next will
 * refuse to bundle it into client code.
 */

import { createServerClient as createSsrClient, type CookieOptions } from '@supabase/ssr';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export type CrmSupabaseClient = SupabaseClient;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. The CRM needs Supabase configured; see .env.example.`
    );
  }
  return value;
}

/**
 * The CRM lives in the same Supabase project as the scorecard funnel tables,
 * which predate it and read `SUPABASE_URL`. Server-side code accepts either
 * name; the browser can only see the NEXT_PUBLIC one.
 */
function supabaseUrl(): string {
  const value = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  if (!value) {
    throw new Error(
      'NEXT_PUBLIC_SUPABASE_URL is not set. The CRM needs Supabase configured; see .env.example.'
    );
  }
  return value;
}

export function isCrmConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  );
}

export function isServiceRoleConfigured(): boolean {
  return Boolean(
    (process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL) &&
      process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

/**
 * Full-access client for trusted server-side work. Bypasses RLS — never call
 * this from a component that renders user-supplied filters straight into a
 * query.
 */
export function createServiceClient(): CrmSupabaseClient {
  return createClient(
    supabaseUrl(),
    requireEnv('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}

type CookieStore = {
  get(name: string): { value: string } | undefined;
  set?(options: { name: string; value: string } & CookieOptions): void;
};

/**
 * Session-scoped client for server components and route handlers.
 *
 * Pass `cookies()` from `next/headers`. In a Server Component cookies are
 * read-only, so writes are swallowed — session refresh happens in middleware
 * or a route handler instead.
 */
export function createServerClient(cookieStore: CookieStore): CrmSupabaseClient {
  return createSsrClient(
    requireEnv('NEXT_PUBLIC_SUPABASE_URL'),
    requireEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY'),
    {
      cookies: {
        get(name: string) {
          return cookieStore.get(name)?.value;
        },
        set(name: string, value: string, options: CookieOptions) {
          try {
            cookieStore.set?.({ name, value, ...options });
          } catch {
            // Read-only cookie store (Server Component): ignore.
          }
        },
        remove(name: string, options: CookieOptions) {
          try {
            cookieStore.set?.({ name, value: '', ...options });
          } catch {
            // Read-only cookie store (Server Component): ignore.
          }
        }
      }
    }
  );
}

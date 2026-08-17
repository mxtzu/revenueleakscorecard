/**
 * GET /api/crm/calendar/callback — finish the Google consent flow.
 *
 * The one place tokens exist in this application's memory. They are exchanged
 * here, sealed, and written with the service-role client — the only client
 * that can reach `calendar_credentials`, which has RLS on and no policies.
 *
 * Three checks before anything is stored:
 *   - there is a signed-in profile (the connection belongs to a person),
 *   - the `state` matches the cookie set by /connect (nobody else's Google
 *     account can be attached to this profile),
 *   - Google returned a refresh token (without one the connection dies in an
 *     hour, and it is better to say so now than to look connected and stop).
 */

import { NextResponse, type NextRequest } from 'next/server';

import { exchangeCode, fetchAccountEmail, oauthConfig } from '@/lib/calendar/oauth';
import { readCredentials, storeCredentials } from '@/lib/calendar/tokens';
import { canWrite } from '@/lib/crm/permissions';
import { crmSession } from '@/lib/crm/server';
import { createServiceClient, isCrmConfigured, isServiceRoleConfigured } from '@/lib/crm/supabase';
import { STATE_COOKIE } from '@/lib/calendar/webhookAuth';


export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function finish(request: NextRequest, params: Record<string, string>) {
  const url = new URL('/calendar', request.url);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = NextResponse.redirect(url, { status: 303 });
  // One-time value: clear it whether this succeeded or not.
  response.cookies.set({ name: STATE_COOKIE, value: '', path: '/api/crm/calendar', maxAge: 0 });
  return response;
}

export async function GET(request: NextRequest) {
  if (!isCrmConfigured()) return finish(request, { error: 'The CRM is not configured.' });
  if (!isServiceRoleConfigured()) {
    return finish(request, {
      error: 'SUPABASE_SERVICE_ROLE_KEY is not set, so the calendar tokens cannot be stored.'
    });
  }

  const url = request.nextUrl;
  const denied = url.searchParams.get('error');
  if (denied) {
    return finish(request, {
      error: denied === 'access_denied' ? 'Google access was declined.' : `Google said: ${denied}`
    });
  }

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const expected = request.cookies.get(STATE_COOKIE)?.value;

  if (!code) return finish(request, { error: 'Google did not return an authorisation code.' });
  if (!state || !expected || state !== expected) {
    // Either a stale tab or a forged callback; both are refused the same way.
    return finish(request, { error: 'That sign-in did not match this browser. Try connecting again.' });
  }

  const { profile } = await crmSession();
  if (!profile) return finish(request, { error: 'Sign in before connecting a calendar.' });
  if (!canWrite(profile)) return finish(request, { error: 'Your role is read-only.' });

  try {
    const config = oauthConfig(process.env, url.origin);
    const tokens = await exchangeCode(config, code);
    const email = (await fetchAccountEmail(tokens.accessToken)) ?? profile.email ?? 'unknown';

    const service = createServiceClient();

    // Reconnecting the same profile updates the existing row rather than
    // failing the unique constraint on profile_id.
    const { data: existing } = await service
      .from('calendar_accounts')
      .select('id')
      .eq('profile_id', profile.id)
      .maybeSingle();

    const { data: saved, error } = await service
      .from('calendar_accounts')
      .upsert(
        {
          ...(existing ? { id: (existing as { id: string }).id } : {}),
          profile_id: profile.id,
          provider: 'google',
          google_email: email,
          calendar_id: 'primary',
          scope: tokens.scope,
          // A reconnection is a new grant: the old cursor belongs to the old
          // authorisation and reusing it would skip everything that changed in
          // between.
          sync_token: null,
          is_active: true,
          last_error: null
        },
        { onConflict: 'profile_id' }
      )
      .select('id')
      .single();

    if (error || !saved) {
      return finish(request, { error: `Could not save the connection: ${error?.message ?? 'unknown'}` });
    }

    const accountId = (saved as { id: string }).id;
    const previous = await readCredentials(service, accountId);

    if (!tokens.refreshToken && !previous?.refresh_token_enc) {
      return finish(request, {
        error:
          'Google did not return a refresh token, so the connection would stop working within the hour. ' +
          'Remove this app at myaccount.google.com/permissions and connect again.'
      });
    }

    await storeCredentials(service, accountId, tokens, {
      keepRefreshToken: previous?.refresh_token_enc ?? null
    });

    return finish(request, { connected: email });
  } catch (error) {
    return finish(request, { error: (error as Error).message });
  }
}

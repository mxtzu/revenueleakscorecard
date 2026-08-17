/**
 * GET /api/crm/calendar/connect — start the Google consent flow.
 *
 * Redirects to Google with a one-time `state` value, which is also written to
 * a short-lived HttpOnly cookie. The callback compares the two: without that,
 * anyone could send a signed-in user to a crafted callback URL and attach
 * *their* Google account to the user's CRM profile.
 *
 * GET, because it is a navigation — but it only ever redirects to Google, and
 * nothing is written until the callback comes back with a matching state.
 */

import { randomBytes } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';

import { isTokenKeyConfigured } from '@/lib/calendar/crypto';
import { authorizeUrl, isGoogleConfigured, oauthConfig } from '@/lib/calendar/oauth';
import { canWrite } from '@/lib/crm/permissions';
import { crmSession } from '@/lib/crm/server';
import { isCrmConfigured } from '@/lib/crm/supabase';
import { STATE_COOKIE } from '@/lib/calendar/webhookAuth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function back(request: NextRequest, error: string) {
  const url = new URL('/calendar', request.url);
  url.searchParams.set('error', error);
  return NextResponse.redirect(url, { status: 303 });
}

export async function GET(request: NextRequest) {
  if (!isCrmConfigured()) return back(request, 'The CRM is not configured.');

  const { profile } = await crmSession();
  if (!profile) return NextResponse.redirect(new URL('/login?next=/calendar', request.url), { status: 303 });
  if (!canWrite(profile)) {
    return back(request, 'Your role is read-only, so there is nothing to sync a calendar with.');
  }

  if (!isGoogleConfigured()) {
    return back(
      request,
      'Google is not configured on this deployment. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.'
    );
  }
  // Checked before consent rather than after: without the key the tokens
  // cannot be stored, and finding that out after the user has authorised is a
  // worse experience than not offering the button.
  if (!isTokenKeyConfigured()) {
    return back(
      request,
      'CALENDAR_TOKEN_KEY is not set, so OAuth tokens could not be stored securely. Generate one with: openssl rand -base64 32'
    );
  }

  let target: string;
  const state = randomBytes(24).toString('base64url');
  try {
    target = authorizeUrl(oauthConfig(process.env, request.nextUrl.origin), state, profile.email ?? undefined);
  } catch (error) {
    return back(request, (error as Error).message);
  }

  const response = NextResponse.redirect(target, { status: 303 });
  response.cookies.set({
    name: STATE_COOKIE,
    value: state,
    httpOnly: true,
    sameSite: 'lax', // must survive the redirect back from accounts.google.com
    secure: request.nextUrl.protocol === 'https:',
    path: '/api/crm/calendar',
    maxAge: 600
  });
  return response;
}

/**
 * Google OAuth 2.0, authorization-code flow with a server-side exchange.
 *
 * The client secret never leaves the server and the tokens never reach the
 * browser: the redirect handler exchanges the code, seals the tokens and
 * stores them, and the page only ever learns which email address is connected.
 *
 * Scope is `calendar.events` — permission to manage events, not to read the
 * user's whole Google account. `calendar.readonly` would not allow booking and
 * the broader `calendar` scope grants calendar creation and deletion, which
 * nothing here needs.
 */

import { type CalendarEnv } from './crypto';
import { defaultTransport, query, readJson, type Transport } from './http';

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';
const USERINFO_ENDPOINT = 'https://www.googleapis.com/oauth2/v3/userinfo';

export const CALENDAR_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/userinfo.email'
] as const;

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface TokenSet {
  accessToken: string;
  /** Only sent on the first consent, so an existing one is never overwritten with null. */
  refreshToken: string | null;
  expiresAt: string;
  scope: string | null;
}

/** Is Google configured at all? The UI asks before offering a Connect button. */
export function isGoogleConfigured(env: CalendarEnv = process.env): boolean {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}

export function oauthConfig(
  env: CalendarEnv = process.env,
  origin?: string
): OAuthConfig {
  const clientId = env.GOOGLE_CLIENT_ID;
  const clientSecret = env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set. See docs/agency-crm.md.'
    );
  }
  // The redirect URI has to match what is registered in the Google console
  // exactly. It is derived from the request origin so preview deployments work,
  // but an explicit override wins because that is what a fixed registration
  // needs.
  const base = env.GOOGLE_REDIRECT_URI ?? (origin ? `${origin}/api/crm/calendar/callback` : null);
  if (!base) {
    throw new Error('GOOGLE_REDIRECT_URI is not set and no request origin was available.');
  }
  return { clientId, clientSecret, redirectUri: base };
}

/**
 * Where to send the user to consent.
 *
 * `access_type=offline` with `prompt=consent` is what makes Google return a
 * refresh token. Without them the CRM gets an hour of access and then silently
 * stops syncing — and Google only sends a refresh token on a *fresh* consent,
 * so re-authorising without `prompt=consent` returns nothing usable.
 */
export function authorizeUrl(config: OAuthConfig, state: string, loginHint?: string): string {
  return (
    AUTH_ENDPOINT +
    query({
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      response_type: 'code',
      scope: CALENDAR_SCOPES.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state,
      login_hint: loginHint
    })
  );
}

function expiryFrom(seconds: number | undefined): string {
  // 60 seconds of slack, so a token is never used in the last moment before it
  // expires and fails mid-request.
  const lifetime = typeof seconds === 'number' && seconds > 0 ? seconds : 3600;
  return new Date(Date.now() + (lifetime - 60) * 1000).toISOString();
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

export async function exchangeCode(
  config: OAuthConfig,
  code: string,
  transport: Transport = defaultTransport()
): Promise<TokenSet> {
  const response = await transport({
    method: 'POST',
    url: TOKEN_ENDPOINT,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      grant_type: 'authorization_code'
    }).toString()
  });

  const payload = readJson<TokenResponse>(response, 'Could not complete the Google sign-in');
  if (!payload.access_token) {
    throw new Error('Google did not return an access token.');
  }
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token ?? null,
    expiresAt: expiryFrom(payload.expires_in),
    scope: payload.scope ?? null
  };
}

export async function refreshAccessToken(
  config: OAuthConfig,
  refreshToken: string,
  transport: Transport = defaultTransport()
): Promise<TokenSet> {
  const response = await transport({
    method: 'POST',
    url: TOKEN_ENDPOINT,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: 'refresh_token'
    }).toString()
  });

  const payload = readJson<TokenResponse>(response, 'Could not refresh the Google token');
  if (!payload.access_token) {
    throw new Error('Google did not return a refreshed access token.');
  }
  return {
    accessToken: payload.access_token,
    // A refresh response does not repeat the refresh token. Returning null and
    // letting the caller keep the stored one is the difference between a
    // connection that lasts and one that dies at the first refresh.
    refreshToken: payload.refresh_token ?? null,
    expiresAt: expiryFrom(payload.expires_in),
    scope: payload.scope ?? null
  };
}

/** Which Google account consented. Shown on the calendar page. */
export async function fetchAccountEmail(
  accessToken: string,
  transport: Transport = defaultTransport()
): Promise<string | null> {
  const response = await transport({
    method: 'GET',
    url: USERINFO_ENDPOINT,
    headers: { authorization: `Bearer ${accessToken}` }
  });
  const payload = readJson<{ email?: string }>(response, 'Could not read the Google account');
  return payload.email ?? null;
}

/**
 * Withdraw the grant at Google, not just locally.
 *
 * Deleting our row alone would leave the CRM listed indefinitely in the user's
 * Google account permissions with a refresh token that still works.
 */
export async function revokeToken(
  token: string,
  transport: Transport = defaultTransport()
): Promise<void> {
  const response = await transport({
    method: 'POST',
    url: REVOKE_ENDPOINT,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }).toString()
  });
  // 400 means already revoked or expired, which is the state we wanted anyway.
  if (response.status >= 400 && response.status !== 400) {
    readJson(response, 'Could not revoke the Google token');
  }
}

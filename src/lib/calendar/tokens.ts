/**
 * Getting a usable access token, refreshing it when it has aged out.
 *
 * Access tokens last an hour; refresh tokens last until the user revokes them.
 * Everything here runs with the service-role client, because
 * `calendar_credentials` has no RLS policy for any other caller — that is
 * deliberate, and it means token handling can only happen server-side.
 */

import type { CrmSupabaseClient } from '@/lib/crm/supabase';

import { openToken, sealOptional, sealToken } from './crypto';
import { GoogleApiError, type Transport } from './http';
import { oauthConfig, refreshAccessToken, type OAuthConfig, type TokenSet } from './oauth';
import type { CalendarAccount, CalendarCredentials } from './types';

/** Raised when the connection is dead and the user has to reconnect. */
export class CalendarAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CalendarAuthError';
  }
}

/** Refresh this far before expiry, so a token never dies mid-request. */
const REFRESH_MARGIN_MS = 2 * 60 * 1000;

function isExpired(expiresAt: string | null): boolean {
  if (!expiresAt) return true;
  return new Date(expiresAt).getTime() - REFRESH_MARGIN_MS <= Date.now();
}

export async function readCredentials(
  service: CrmSupabaseClient,
  accountId: string
): Promise<CalendarCredentials | null> {
  const { data, error } = await service
    .from('calendar_credentials')
    .select('*')
    .eq('calendar_account_id', accountId)
    .maybeSingle();
  if (error) throw new Error(`Could not read the calendar credentials: ${error.message}`);
  return (data as CalendarCredentials | null) ?? null;
}

export async function storeCredentials(
  service: CrmSupabaseClient,
  accountId: string,
  tokens: TokenSet,
  options: { keepRefreshToken?: string | null } = {}
): Promise<void> {
  // Google only returns a refresh token on the first consent. Overwriting the
  // stored one with null on every refresh is how a connection silently dies an
  // hour after it is made.
  const refresh = tokens.refreshToken
    ? sealToken(tokens.refreshToken)
    : (options.keepRefreshToken ?? null);

  const { error } = await service.from('calendar_credentials').upsert(
    {
      calendar_account_id: accountId,
      access_token_enc: sealToken(tokens.accessToken),
      refresh_token_enc: refresh,
      token_expires_at: tokens.expiresAt
    },
    { onConflict: 'calendar_account_id' }
  );
  if (error) throw new Error(`Could not store the calendar credentials: ${error.message}`);
}

/** Seal a value for storage without going through a full TokenSet. */
export { sealOptional };

/**
 * A live access token for this account.
 *
 * Refreshes and persists when needed, so the next caller does not repeat the
 * round trip. An `invalid_grant` means the user revoked access at Google: the
 * connection is marked inactive with a reason, because a sync that keeps
 * quietly failing looks identical to a calendar with nothing in it.
 */
export async function accessTokenFor(
  service: CrmSupabaseClient,
  account: CalendarAccount,
  options: { transport?: Transport; config?: OAuthConfig } = {}
): Promise<string> {
  const credentials = await readCredentials(service, account.id);
  if (!credentials) {
    throw new CalendarAuthError(
      `No stored credentials for ${account.google_email}. Reconnect the calendar.`
    );
  }

  if (!isExpired(credentials.token_expires_at)) {
    return openToken(credentials.access_token_enc);
  }

  if (!credentials.refresh_token_enc) {
    await deactivate(service, account.id, 'The access token expired and no refresh token is stored.');
    throw new CalendarAuthError(
      `The Google connection for ${account.google_email} has expired. Reconnect the calendar.`
    );
  }

  const config = options.config ?? oauthConfig();
  let refreshed: TokenSet;
  try {
    refreshed = await refreshAccessToken(
      config,
      openToken(credentials.refresh_token_enc),
      options.transport
    );
  } catch (error) {
    if (error instanceof GoogleApiError && error.isAuthFailure) {
      await deactivate(
        service,
        account.id,
        'Google rejected the refresh token. Access was probably revoked.'
      );
      throw new CalendarAuthError(
        `Google has revoked access for ${account.google_email}. Reconnect the calendar.`
      );
    }
    throw error;
  }

  await storeCredentials(service, account.id, refreshed, {
    keepRefreshToken: credentials.refresh_token_enc
  });
  return refreshed.accessToken;
}

export async function deactivate(
  service: CrmSupabaseClient,
  accountId: string,
  reason: string
): Promise<void> {
  await service
    .from('calendar_accounts')
    .update({ is_active: false, last_error: reason })
    .eq('id', accountId);
}

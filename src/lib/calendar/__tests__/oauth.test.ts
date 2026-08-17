import { describe, expect, it } from 'vitest';

import { GoogleApiError } from '../http';
import {
  authorizeUrl,
  CALENDAR_SCOPES,
  exchangeCode,
  isGoogleConfigured,
  oauthConfig,
  refreshAccessToken,
  revokeToken
} from '../oauth';

const CONFIG = {
  clientId: 'client-id.apps.googleusercontent.com',
  clientSecret: 'client-secret',
  redirectUri: 'https://crm.agency.test/api/crm/calendar/callback'
};

function respond(status: number, body: unknown) {
  const calls: { url: string; body?: string }[] = [];
  const transport = async (request: { url: string; body?: string }) => {
    calls.push(request);
    return { status, body: JSON.stringify(body) };
  };
  return { transport, calls };
}

describe('the consent URL', () => {
  const url = new URL(authorizeUrl(CONFIG, 'state-123'));

  it('asks for offline access and a fresh consent', () => {
    // Without both of these Google returns no refresh token, and the CRM
    // stops syncing an hour later with nothing to show why.
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
  });

  it('asks only for calendar events, not the whole account', () => {
    expect(url.searchParams.get('scope')).toBe(CALENDAR_SCOPES.join(' '));
    expect(url.searchParams.get('scope')).not.toContain('auth/calendar ');
  });

  it('carries the CSRF state and the redirect', () => {
    expect(url.searchParams.get('state')).toBe('state-123');
    expect(url.searchParams.get('redirect_uri')).toBe(CONFIG.redirectUri);
    expect(url.searchParams.get('response_type')).toBe('code');
  });

  it('passes a login hint only when there is one', () => {
    expect(url.searchParams.has('login_hint')).toBe(false);
    const hinted = new URL(authorizeUrl(CONFIG, 's', 'rep@agency.test'));
    expect(hinted.searchParams.get('login_hint')).toBe('rep@agency.test');
  });
});

describe('configuration', () => {
  it('reports whether Google is set up at all', () => {
    expect(isGoogleConfigured({})).toBe(false);
    expect(
      isGoogleConfigured({ GOOGLE_CLIENT_ID: 'a', GOOGLE_CLIENT_SECRET: 'b' })
    ).toBe(true);
  });

  it('derives the redirect from the request origin, and lets an env var win', () => {
    const base = { GOOGLE_CLIENT_ID: 'a', GOOGLE_CLIENT_SECRET: 'b' };
    expect(oauthConfig(base, 'https://preview.vercel.app').redirectUri).toBe(
      'https://preview.vercel.app/api/crm/calendar/callback'
    );
    expect(
      oauthConfig({ ...base, GOOGLE_REDIRECT_URI: 'https://fixed.test/cb' }, 'https://ignored.test')
        .redirectUri
    ).toBe('https://fixed.test/cb');
  });

  it('will not guess when nothing is configured', () => {
    expect(() => oauthConfig({})).toThrow(/GOOGLE_CLIENT_ID/);
  });
});

describe('exchanging the code', () => {
  it('sends the secret in the body, never the URL', async () => {
    const { transport, calls } = respond(200, {
      access_token: 'at',
      refresh_token: 'rt',
      expires_in: 3599,
      scope: 'calendar.events'
    });
    const tokens = await exchangeCode(CONFIG, 'auth-code', transport);

    expect(calls[0].url).not.toContain('client-secret');
    expect(calls[0].body).toContain('client_secret=client-secret');
    expect(calls[0].body).toContain('grant_type=authorization_code');
    expect(tokens.accessToken).toBe('at');
    expect(tokens.refreshToken).toBe('rt');
  });

  it('expires the token slightly early, so it is never used at the last moment', async () => {
    const { transport } = respond(200, { access_token: 'at', expires_in: 3600 });
    const tokens = await exchangeCode(CONFIG, 'code', transport);
    const seconds = (new Date(tokens.expiresAt).getTime() - Date.now()) / 1000;
    expect(seconds).toBeGreaterThan(3500);
    expect(seconds).toBeLessThan(3600);
  });

  it('surfaces Google’s own explanation', async () => {
    const { transport } = respond(400, {
      error: 'invalid_grant',
      error_description: 'Code was already redeemed.'
    });
    await expect(exchangeCode(CONFIG, 'used', transport)).rejects.toThrow(
      /Code was already redeemed/
    );
  });
});

describe('refreshing', () => {
  it('returns a null refresh token rather than inventing one', async () => {
    // A refresh response does not repeat the refresh token. Storing this null
    // would kill the connection, so the caller is made to decide.
    const { transport } = respond(200, { access_token: 'new-at', expires_in: 3600 });
    const tokens = await refreshAccessToken(CONFIG, 'stored-rt', transport);
    expect(tokens.accessToken).toBe('new-at');
    expect(tokens.refreshToken).toBeNull();
  });

  it('marks a revoked grant as an auth failure, not a retry', async () => {
    const { transport } = respond(400, { error: 'invalid_grant' });
    try {
      await refreshAccessToken(CONFIG, 'revoked', transport);
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(GoogleApiError);
      expect((error as GoogleApiError).isAuthFailure).toBe(true);
      expect((error as GoogleApiError).isTransient).toBe(false);
    }
  });

  it('treats a 503 as worth retrying', async () => {
    const { transport } = respond(503, { error: { message: 'backend error' } });
    try {
      await refreshAccessToken(CONFIG, 'rt', transport);
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as GoogleApiError).isTransient).toBe(true);
      expect((error as GoogleApiError).isAuthFailure).toBe(false);
    }
  });
});

describe('revoking', () => {
  it('does not treat an already-dead token as a failure', async () => {
    // 400 from /revoke means the token was already invalid, which is the state
    // we were trying to reach.
    const { transport } = respond(400, { error: 'invalid_token' });
    await expect(revokeToken('dead', transport)).resolves.toBeUndefined();
  });
});

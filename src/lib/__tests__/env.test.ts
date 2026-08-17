import { describe, expect, it } from 'vitest';

import { hasFailures, inspectEnv, looksLikeServiceRoleJwt, type Env } from '../env';

/** A minimally valid production configuration. */
function base(overrides: Env = {}): Env {
  return {
    NEXT_PUBLIC_SUPABASE_URL: 'https://project.supabase.co',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
    SUPABASE_SERVICE_ROLE_KEY: 'service-key',
    ...overrides
  };
}

function failures(env: Env): string[] {
  return inspectEnv(env)
    .filter((finding) => finding.level === 'fail')
    .map((finding) => finding.detail);
}

/** Build a Supabase-shaped JWT with the given role claim. */
function jwt(role: string): string {
  const payload = Buffer.from(JSON.stringify({ role, iss: 'supabase' })).toString('base64url');
  return `eyJhbGciOiJIUzI1NiJ9.${payload}.signature`;
}

describe('the minimum', () => {
  it('passes a coherent configuration', () => {
    expect(hasFailures(inspectEnv(base()))).toBe(false);
  });

  it('fails without Supabase', () => {
    expect(failures({})).toContain('NEXT_PUBLIC_SUPABASE_URL is not set');
    expect(failures({})).toContain('SUPABASE_SERVICE_ROLE_KEY is not set');
  });

  it('fails on a non-https Supabase URL', () => {
    expect(failures(base({ NEXT_PUBLIC_SUPABASE_URL: 'http://project.supabase.co' }))).toContain(
      'NEXT_PUBLIC_SUPABASE_URL is not https'
    );
  });
});

/**
 * The catastrophic, silent mistake: pasting the service-role key into the anon
 * slot. The app works perfectly and RLS stops applying to every browser.
 */
describe('the service-role key in the wrong slot', () => {
  it('is recognised from the role claim', () => {
    expect(looksLikeServiceRoleJwt(jwt('service_role'))).toBe(true);
    expect(looksLikeServiceRoleJwt(jwt('anon'))).toBe(false);
    expect(looksLikeServiceRoleJwt('not-a-jwt')).toBe(false);
    expect(looksLikeServiceRoleJwt('a.b')).toBe(false);
  });

  it('fails the preflight', () => {
    const found = failures(base({ NEXT_PUBLIC_SUPABASE_ANON_KEY: jwt('service_role') }));
    expect(found.some((detail) => detail.includes('service_role'))).toBe(true);
  });

  it('does not fire on a normal anon key', () => {
    expect(hasFailures(inspectEnv(base({ NEXT_PUBLIC_SUPABASE_ANON_KEY: jwt('anon') })))).toBe(
      false
    );
  });
});

describe('secrets in the browser bundle', () => {
  it('fails on any NEXT_PUBLIC_ secret', () => {
    for (const name of [
      'NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY',
      'NEXT_PUBLIC_STRIPE_SECRET_KEY',
      'NEXT_PUBLIC_RESEND_API_KEY',
      'NEXT_PUBLIC_CALENDAR_TOKEN_KEY'
    ]) {
      const found = failures(base({ [name]: 'oops' }));
      expect(found.some((detail) => detail.includes(name))).toBe(true);
    }
  });

  it('does not object to the two that belong there', () => {
    expect(hasFailures(inspectEnv(base({ NEXT_PUBLIC_SITE_URL: 'https://crm.test' })))).toBe(false);
  });
});

/**
 * Each of these is worse than not configuring the feature at all: the app looks
 * finished and quietly does not work.
 */
describe('half-configurations', () => {
  it('fails a Stripe key with no webhook secret', () => {
    expect(failures(base({ STRIPE_SECRET_KEY: 'sk_test_x' }))).toContain(
      'STRIPE_SECRET_KEY is set but STRIPE_WEBHOOK_SECRET is not'
    );
  });

  it('fails a Google client with no token key', () => {
    const found = failures(
      base({ GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret' })
    );
    expect(found).toContain('CALENDAR_TOKEN_KEY is not set');
  });

  it('fails a token key that is the wrong length', () => {
    const found = failures(
      base({
        GOOGLE_CLIENT_ID: 'id',
        GOOGLE_CLIENT_SECRET: 'secret',
        CALENDAR_TOKEN_KEY: Buffer.from('too short').toString('base64')
      })
    );
    expect(found.some((detail) => detail.includes('not 32'))).toBe(true);
  });

  it('accepts a correct token key', () => {
    expect(
      hasFailures(
        inspectEnv(
          base({
            GOOGLE_CLIENT_ID: 'id',
            GOOGLE_CLIENT_SECRET: 'secret',
            CALENDAR_TOKEN_KEY: Buffer.alloc(32, 7).toString('base64')
          })
        )
      )
    ).toBe(false);
  });

  it('fails one half of the Google pair', () => {
    expect(failures(base({ GOOGLE_CLIENT_ID: 'id' }))).toContain(
      'Only one of GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET is set'
    );
  });

  it('fails an email provider with no webhook secret', () => {
    const found = failures(
      base({ RESEND_API_KEY: 're_x', NEXT_PUBLIC_SITE_URL: 'https://crm.test' })
    );
    expect(found).toContain('RESEND_API_KEY is set but RESEND_WEBHOOK_SECRET is not');
  });

  /**
   * Unsubscribe links have to keep working for months. Derived from the request
   * origin, they would point at whichever preview deployment happened to send.
   */
  it('fails outreach with no site URL', () => {
    const found = failures(base({ RESEND_API_KEY: 're_x', RESEND_WEBHOOK_SECRET: 'whsec_x' }));
    expect(found).toContain('NEXT_PUBLIC_SITE_URL is not set');
  });

  it('fails an http site URL', () => {
    const found = failures(
      base({
        RESEND_API_KEY: 're_x',
        RESEND_WEBHOOK_SECRET: 'whsec_x',
        NEXT_PUBLIC_SITE_URL: 'http://crm.test'
      })
    );
    expect(found).toContain('NEXT_PUBLIC_SITE_URL is not https');
  });
});

describe('the build target', () => {
  it('fails a static export', () => {
    // The CRM is server-rendered per request; a static export ships an app
    // where nothing works and nothing says why.
    expect(failures(base({ GITHUB_PAGES: 'true' }))).toContain(
      'GITHUB_PAGES=true forces a static export'
    );
  });
});

describe('warnings', () => {
  function warnings(env: Env): string[] {
    return inspectEnv(env)
      .filter((finding) => finding.level === 'warn')
      .map((finding) => finding.detail);
  }

  it('notices a short shared secret', () => {
    expect(warnings(base({ LEAD_SYNC_SECRET: 'short' }))).toContain(
      'LEAD_SYNC_SECRET is only 5 characters'
    );
  });

  it('notices no error monitoring, without blocking the deploy', () => {
    const found = inspectEnv(base());
    expect(found.some((finding) => finding.level === 'warn' && /SENTRY_DSN/.test(finding.detail))).toBe(
      true
    );
    expect(hasFailures(found)).toBe(false);
  });

  it('is quiet once monitoring is set up', () => {
    const found = inspectEnv(base({ SENTRY_DSN: 'https://x@y.ingest.sentry.io/1' }));
    expect(found.some((finding) => /SENTRY_DSN is not set/.test(finding.detail))).toBe(false);
  });
});

describe('ordering', () => {
  it('puts failures first, so the important line is at the top', () => {
    const found = inspectEnv({ GITHUB_PAGES: 'true' });
    expect(found[0].level).toBe('fail');
  });
});

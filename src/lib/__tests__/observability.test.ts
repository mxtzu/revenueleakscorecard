import { describe, expect, it } from 'vitest';

import { isMonitoringConfigured, maskAddress, scrub } from '../observability';

/**
 * The things most tempting to attach to an error report here are exactly the
 * things that must not leave the process: an access token, a webhook secret, a
 * prospect's email address. This runs over everything before it is sent.
 */
describe('scrubbing', () => {
  it('redacts anything that looks like a credential', () => {
    const scrubbed = scrub({
      access_token: 'ya29.secret',
      refresh_token_enc: 'v1.sealed',
      STRIPE_SECRET_KEY: 'sk_live_x',
      stripe_signature: 't=1,v1=abc',
      authorization: 'Bearer x',
      apiKey: 'k',
      password: 'hunter2',
      cookie: 'sb-access-token=x'
    }) as Record<string, unknown>;

    for (const value of Object.values(scrubbed)) {
      expect(value).toBe('[redacted]');
    }
  });

  it('keeps the useful half of an address and drops the identifying half', () => {
    // "every failure is to gmail.com" is a real finding; whose inbox it was is
    // not something a third party needs.
    expect(maskAddress('dana@riverside.test')).toBe('d***@riverside.test');
    const scrubbed = scrub({ to_email: 'owner@practice.co.uk' }) as Record<string, unknown>;
    expect(scrubbed.to_email).toBe('o***@practice.co.uk');
  });

  it('masks a phone number but keeps enough to tell two apart', () => {
    expect(maskAddress('+44 7700 900222')).toBe('***22');
  });

  it('leaves ordinary diagnostic fields alone', () => {
    const scrubbed = scrub({
      operation: 'outreach.run',
      step_number: 3,
      status: 'failed',
      lead_id: 'abc-123'
    }) as Record<string, unknown>;

    expect(scrubbed).toEqual({
      operation: 'outreach.run',
      step_number: 3,
      status: 'failed',
      lead_id: 'abc-123'
    });
  });

  it('reaches into nested objects and arrays', () => {
    const scrubbed = scrub({
      request: { headers: { authorization: 'Bearer x' }, path: '/api/x' },
      recipients: [{ email: 'a@b.test' }]
    }) as { request: { headers: Record<string, unknown>; path: string }; recipients: { email: string }[] };

    expect(scrubbed.request.headers.authorization).toBe('[redacted]');
    expect(scrubbed.request.path).toBe('/api/x');
    expect(scrubbed.recipients[0].email).toBe('a***@b.test');
  });

  it('truncates rather than shipping a whole response body', () => {
    const scrubbed = scrub({ body: 'x'.repeat(2000) }) as Record<string, string>;
    expect(scrubbed.body).toContain('[2000 chars]');
    expect(scrubbed.body.length).toBeLessThan(600);
  });

  it('stops at a depth cap, so a cyclic object cannot become the payload', () => {
    const cyclic: Record<string, unknown> = { name: 'root' };
    cyclic.self = cyclic;
    expect(() => scrub(cyclic)).not.toThrow();
    expect(JSON.stringify(scrub(cyclic))).toContain('[truncated]');
  });

  it('caps how much of a long array is reported', () => {
    const scrubbed = scrub(Array.from({ length: 100 }, (_, index) => index)) as number[];
    expect(scrubbed).toHaveLength(20);
  });

  it('passes null and undefined through untouched', () => {
    expect(scrub(null)).toBeNull();
    expect(scrub(undefined)).toBeUndefined();
  });
});

describe('configuration', () => {
  it('is off without a DSN', () => {
    expect(isMonitoringConfigured({})).toBe(false);
    expect(isMonitoringConfigured({ SENTRY_DSN: 'https://x@y.ingest.sentry.io/1' })).toBe(true);
    expect(isMonitoringConfigured({ NEXT_PUBLIC_SENTRY_DSN: 'https://x@y.ingest.sentry.io/1' })).toBe(
      true
    );
  });
});

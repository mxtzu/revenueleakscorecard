import { describe, expect, it } from 'vitest';

import { channelToken, secretMatches, tokenMatches } from '../webhookAuth';

const SECRET = 'a-server-side-secret-value';

describe('the push channel token', () => {
  it('is different for every channel', () => {
    // Otherwise one leaked notification would authenticate for every account.
    expect(channelToken('channel-a', SECRET)).not.toBe(channelToken('channel-b', SECRET));
  });

  it('cannot be produced without the secret', () => {
    expect(channelToken('channel-a', SECRET)).not.toBe(channelToken('channel-a', 'guessed'));
  });

  it('is stable, so a channel keeps authenticating for its whole life', () => {
    expect(channelToken('channel-a', SECRET)).toBe(channelToken('channel-a', SECRET));
  });

  it('is URL-safe, because it travels in an HTTP header', () => {
    expect(channelToken('channel-a', SECRET)).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('comparing secrets', () => {
  it('accepts the right value and rejects everything else', () => {
    const expected = channelToken('channel-a', SECRET);
    expect(tokenMatches(expected, expected)).toBe(true);
    expect(tokenMatches(channelToken('channel-b', SECRET), expected)).toBe(false);
    expect(tokenMatches(null, expected)).toBe(false);
    expect(tokenMatches('', expected)).toBe(false);
  });

  it('does not throw on a length mismatch', () => {
    // timingSafeEqual raises on unequal lengths, so the length is checked
    // first — a thrown error here would become a 500 that tells an attacker
    // their guess was the wrong length.
    expect(() => tokenMatches('short', channelToken('c', SECRET))).not.toThrow();
    expect(tokenMatches('short', channelToken('c', SECRET))).toBe(false);
  });

  it('guards the scheduled sync endpoint the same way', () => {
    expect(secretMatches('abc123', 'abc123')).toBe(true);
    expect(secretMatches('abc124', 'abc123')).toBe(false);
    expect(secretMatches(null, 'abc123')).toBe(false);
    expect(() => secretMatches('a', 'abc123')).not.toThrow();
  });
});

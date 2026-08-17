import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { isTokenKeyConfigured, openToken, sealToken, TokenCryptoError, tokenKey } from '../crypto';

const KEY = randomBytes(32).toString('base64');
const OTHER_KEY = randomBytes(32).toString('base64');
const env = (value?: string) => ({ CALENDAR_TOKEN_KEY: value });

describe('sealing tokens', () => {
  it('round-trips a refresh token', () => {
    const token = '1//0gValidLookingRefreshToken_with-symbols';
    expect(openToken(sealToken(token, env(KEY)), env(KEY))).toBe(token);
  });

  it('never stores the token in the clear', () => {
    const sealed = sealToken('super-secret-token', env(KEY));
    expect(sealed).not.toContain('super-secret-token');
    expect(sealed.startsWith('v1.')).toBe(true);
  });

  it('produces different ciphertext each time', () => {
    // A fresh IV per seal. Identical ciphertext for identical input would tell
    // anyone reading the table which two accounts share a token.
    const a = sealToken('same', env(KEY));
    const b = sealToken('same', env(KEY));
    expect(a).not.toBe(b);
    expect(openToken(a, env(KEY))).toBe(openToken(b, env(KEY)));
  });

  it('refuses a tampered value rather than returning something wrong', () => {
    // GCM authenticates the ciphertext, which is the reason for choosing it.
    const sealed = sealToken('token', env(KEY));
    const parts = sealed.split('.');
    const flipped = Buffer.from(parts[3], 'base64url');
    flipped[0] ^= 0xff;
    const tampered = [parts[0], parts[1], parts[2], flipped.toString('base64url')].join('.');
    expect(() => openToken(tampered, env(KEY))).toThrow(TokenCryptoError);
  });

  it('fails with the wrong key, and says to reconnect', () => {
    const sealed = sealToken('token', env(KEY));
    expect(() => openToken(sealed, env(OTHER_KEY))).toThrow(/reconnected/);
  });

  it('rejects a value written by a format this build does not know', () => {
    expect(() => openToken('v2.a.b.c', env(KEY))).toThrow(/not in a format/);
    expect(() => openToken('nonsense', env(KEY))).toThrow(TokenCryptoError);
  });
});

describe('the key itself', () => {
  it('says which variable to set, and how', () => {
    expect(() => tokenKey(env(undefined))).toThrow(/CALENDAR_TOKEN_KEY is not set/);
    expect(() => tokenKey(env(undefined))).toThrow(/openssl rand -base64 32/);
  });

  it('refuses a key that is not 32 bytes', () => {
    // A short key is the kind of thing someone pastes in a hurry; AES would
    // otherwise throw something unreadable from deep inside node:crypto.
    expect(() => tokenKey(env(Buffer.from('too short').toString('base64')))).toThrow(/32 bytes/);
  });

  it('accepts base64url as well as base64', () => {
    const raw = randomBytes(32);
    expect(tokenKey(env(raw.toString('base64url')))).toEqual(raw);
    expect(tokenKey(env(raw.toString('base64')))).toEqual(raw);
  });

  it('reports configuration without throwing', () => {
    expect(isTokenKeyConfigured(env(KEY))).toBe(true);
    expect(isTokenKeyConfigured(env(undefined))).toBe(false);
    expect(isTokenKeyConfigured(env('short'))).toBe(false);
  });
});

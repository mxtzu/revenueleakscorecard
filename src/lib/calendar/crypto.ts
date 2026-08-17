/**
 * Sealing OAuth tokens before they are stored.
 *
 * `calendar_credentials` is already unreachable through PostgREST — RLS on, no
 * policies, service role only. This is the second layer: a Postgres backup, a
 * leaked read-replica, or a logged query result should not hand somebody a
 * live Google refresh token, and each of those bypasses RLS entirely.
 *
 * AES-256-GCM, so the ciphertext is authenticated: a tampered value fails to
 * open rather than decrypting to something attacker-chosen.
 *
 * The format is `v1.<iv>.<tag>.<ciphertext>`, base64url throughout. The version
 * prefix is there so the algorithm can be changed later without having to guess
 * how an old row was written.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * The slice of the environment this module reads.
 *
 * Narrower than `NodeJS.ProcessEnv` so a test can pass `{ CALENDAR_TOKEN_KEY }`
 * without inventing a NODE_ENV it does not care about.
 */
export type CalendarEnv = Record<string, string | undefined>;

const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // 96 bits, the size GCM is specified for
const KEY_BYTES = 32;

export class TokenCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenCryptoError';
  }
}

function b64(buffer: Buffer): string {
  return buffer.toString('base64url');
}

/**
 * The key, from `CALENDAR_TOKEN_KEY`.
 *
 * Read on every call rather than cached at module load: a missing key should
 * fail the request that needed it, with a message saying which variable to
 * set, not the whole process at import time.
 */
export function tokenKey(env: CalendarEnv = process.env): Buffer {
  const raw = env.CALENDAR_TOKEN_KEY;
  if (!raw) {
    throw new TokenCryptoError(
      'CALENDAR_TOKEN_KEY is not set. Generate one with: openssl rand -base64 32'
    );
  }
  // Accept base64 or base64url; both are what `openssl rand -base64 32` and a
  // copy-paste through a URL-safe field produce.
  const key = Buffer.from(raw.trim().replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (key.length !== KEY_BYTES) {
    throw new TokenCryptoError(
      `CALENDAR_TOKEN_KEY must decode to ${KEY_BYTES} bytes; got ${key.length}. ` +
        'Generate one with: openssl rand -base64 32'
    );
  }
  return key;
}

/** Is a usable key configured? Used by the doctor and the connect route. */
export function isTokenKeyConfigured(env: CalendarEnv = process.env): boolean {
  try {
    tokenKey(env);
    return true;
  } catch {
    return false;
  }
}

export function sealToken(plaintext: string, env?: CalendarEnv): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, tokenKey(env), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [VERSION, b64(iv), b64(cipher.getAuthTag()), b64(ciphertext)].join('.');
}

export function openToken(sealed: string, env?: CalendarEnv): string {
  const parts = sealed.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new TokenCryptoError('Stored token is not in a format this build can read.');
  }
  const [, iv, tag, ciphertext] = parts;
  try {
    const decipher = createDecipheriv(ALGORITHM, tokenKey(env), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64url')),
      decipher.final()
    ]).toString('utf8');
  } catch (error) {
    if (error instanceof TokenCryptoError) throw error;
    // Wrong key, or the row was tampered with. Both mean "reconnect the
    // account"; neither should surface a raw crypto error to a page.
    throw new TokenCryptoError(
      'Stored token could not be decrypted. If CALENDAR_TOKEN_KEY changed, the calendar must be reconnected.'
    );
  }
}

/** Seal only when there is something to seal. */
export function sealOptional(value: string | null | undefined, env?: CalendarEnv): string | null {
  return value ? sealToken(value, env) : null;
}

export function openOptional(value: string | null | undefined, env?: CalendarEnv): string | null {
  return value ? openToken(value, env) : null;
}

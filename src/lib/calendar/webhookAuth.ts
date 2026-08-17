/**
 * Shared secrets for the OAuth redirect and Google's push channel.
 *
 * In their own module rather than in the route files: a Next.js route may only
 * export handlers and route config, so anything a second file needs has to
 * live outside them.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The cookie holding the one-time OAuth `state`.
 *
 * Scoped to `/api/crm/calendar` so it is not sent with every request, and read
 * back by the callback to prove the redirect belongs to this browser. Without
 * that check, anyone could send a signed-in user to a crafted callback URL and
 * attach their own Google account to the user's profile.
 */
export const STATE_COOKIE = 'crm_calendar_oauth_state';

/**
 * The token Google echoes back on every push notification for a channel.
 *
 * Derived rather than stored: an HMAC of the channel id under a server secret
 * cannot be produced without the secret, and there is no extra column to leak.
 */
export function channelToken(channelId: string, secret: string): string {
  return createHmac('sha256', secret).update(channelId).digest('base64url');
}

export function tokenMatches(provided: string | null, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Compare a bearer secret without leaking its length through timing.
 *
 * Used by the scheduled sync endpoint.
 */
export function secretMatches(provided: string | null, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

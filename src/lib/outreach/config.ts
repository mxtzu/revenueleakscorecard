/**
 * Which providers this deployment has, if any.
 *
 * Every one of these returns null rather than throwing when unconfigured. The
 * engine then records "no email provider is configured" against the step
 * instead of the whole run collapsing — one missing SMS key should not stop
 * the email sequences.
 */

import { resendProvider, twilioProvider, type EmailProvider, type SmsProvider } from './providers';

export type OutreachEnv = Record<string, string | undefined>;

export function emailProvider(env: OutreachEnv = process.env): EmailProvider | null {
  const key = env.RESEND_API_KEY;
  return key ? resendProvider(key) : null;
}

export function smsProvider(env: OutreachEnv = process.env): SmsProvider | null {
  const sid = env.TWILIO_ACCOUNT_SID;
  const token = env.TWILIO_AUTH_TOKEN;
  return sid && token ? twilioProvider(sid, token) : null;
}

export function isEmailConfigured(env: OutreachEnv = process.env): boolean {
  return Boolean(env.RESEND_API_KEY);
}

export function isSmsConfigured(env: OutreachEnv = process.env): boolean {
  return Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN);
}

/**
 * The public base URL, for unsubscribe links.
 *
 * An explicit value wins over the request origin, because a link that has to
 * survive in somebody's inbox for months should not depend on which preview
 * deployment happened to send it.
 */
export function siteUrl(origin?: string, env: OutreachEnv = process.env): string {
  return env.NEXT_PUBLIC_SITE_URL ?? env.OUTREACH_SITE_URL ?? origin ?? 'http://localhost:3000';
}

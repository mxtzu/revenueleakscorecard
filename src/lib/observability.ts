/**
 * Error reporting.
 *
 * One function, so call sites never import Sentry directly. That matters for
 * two reasons: swapping the sink later touches one file, and — more usefully —
 * everything that reports an error stays testable without a DSN or a network.
 *
 * With `SENTRY_DSN` unset this no-ops apart from a structured console line, so
 * a deployment that has not signed up for anything behaves exactly as it did
 * before this module existed.
 *
 * NOTHING SENSITIVE GOES OUT. `scrub()` runs over every context object before
 * it leaves the process, because the obvious things to attach to an error here
 * are exactly the things that must not be sent to a third party: an access
 * token, a webhook secret, a lead's email address.
 */

import 'server-only';

export type Severity = 'error' | 'warning' | 'info';

export interface ErrorContext {
  /** What was being attempted, in a few words. Becomes the Sentry tag. */
  operation: string;
  severity?: Severity;
  /** Anything useful for diagnosis. Scrubbed before it is sent anywhere. */
  extra?: Record<string, unknown>;
}

/**
 * Keys whose values are never reported.
 *
 * Matched as substrings and case-insensitively, so `stripe_secret_key`,
 * `SUPABASE_SERVICE_ROLE_KEY` and `access_token_enc` are all caught by the
 * short list below.
 */
const SECRET_KEYS = [
  'token',
  'secret',
  'password',
  'authorization',
  'apikey',
  'api_key',
  'signature',
  'cookie',
  'key'
];

/**
 * Fields that identify a person.
 *
 * Redacted rather than dropped: knowing an error involved *an* email address is
 * useful, knowing whose is not, and shipping a prospect's address to a
 * third-party service is a data-protection question nobody wants to answer.
 */
const PERSONAL_KEYS = ['email', 'phone', 'to_email', 'to_phone', 'from_email', 'recipient'];

function looksSecret(key: string): boolean {
  const lower = key.toLowerCase();
  return SECRET_KEYS.some((needle) => lower.includes(needle));
}

function looksPersonal(key: string): boolean {
  const lower = key.toLowerCase();
  return PERSONAL_KEYS.some((needle) => lower.includes(needle));
}

/** Depth cap, so a cyclic or enormous object cannot become the payload. */
const MAX_DEPTH = 4;

export function scrub(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (depth >= MAX_DEPTH) return '[truncated]';

  if (Array.isArray(value)) {
    return value.slice(0, 20).map((entry) => scrub(entry, depth + 1));
  }

  if (typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (looksSecret(key)) {
        output[key] = '[redacted]';
      } else if (looksPersonal(key) && typeof entry === 'string' && entry) {
        output[key] = maskAddress(entry);
      } else {
        // Recurse even when the key looked personal. `recipients` matches the
        // personal list but holds an array, and returning it untouched — which
        // an earlier version did — leaked every address inside it.
        output[key] = scrub(entry, depth + 1);
      }
    }
    return output;
  }

  if (typeof value === 'string' && value.length > 500) {
    return `${value.slice(0, 500)}… [${value.length} chars]`;
  }

  return value;
}

/**
 * `dana@riverside.test` becomes `d***@riverside.test`.
 *
 * The domain is the diagnostically useful half — "every failure is to
 * gmail.com" is a real finding — and the local part is the identifying half.
 */
export function maskAddress(value: string): string {
  const at = value.indexOf('@');
  if (at > 0) return `${value[0]}***${value.slice(at)}`;
  // A phone number: keep the last two digits so two failures can be told apart.
  if (/^\+?[\d\s()-]{6,}$/.test(value)) return `***${value.replace(/\D/g, '').slice(-2)}`;
  return '[redacted]';
}

export function isMonitoringConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.SENTRY_DSN || env.NEXT_PUBLIC_SENTRY_DSN);
}

/**
 * Report something that went wrong.
 *
 * Never throws. A monitoring system that can break the request it is reporting
 * on is worse than no monitoring at all, so every failure inside here is
 * swallowed after one console line.
 */
export async function reportError(error: unknown, context: ErrorContext): Promise<void> {
  const detail = error instanceof Error ? error : new Error(String(error));
  const extra = scrub(context.extra ?? {}) as Record<string, unknown>;
  const severity = context.severity ?? 'error';

  // Always emit a structured line. On Vercel this lands in the runtime logs and
  // is the fallback when no DSN is configured.
  const line = {
    level: severity,
    operation: context.operation,
    message: detail.message,
    ...extra
  };
  if (severity === 'error') console.error('[crm]', JSON.stringify(line));
  else console.warn('[crm]', JSON.stringify(line));

  if (!isMonitoringConfigured()) return;

  try {
    const Sentry = await import('@sentry/nextjs');
    Sentry.withScope((scope) => {
      scope.setTag('operation', context.operation);
      scope.setLevel(severity);
      scope.setContext('detail', extra);
      Sentry.captureException(detail);
    });
  } catch (reportingFailure) {
    console.error('[crm] error reporting itself failed', String(reportingFailure));
  }
}

/**
 * Wrap a background job so a failure is reported rather than lost.
 *
 * Route handlers already return their errors to a caller who can see them. A
 * cron-driven run has nobody watching, which is exactly where silent failure
 * costs the most: an outreach engine that has been throwing for a fortnight
 * looks identical to one with nothing to do.
 */
export async function monitored<T>(
  operation: string,
  work: () => Promise<T>,
  extra?: Record<string, unknown>
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    await reportError(error, { operation, extra });
    throw error;
  }
}

/**
 * What a correct deployment looks like, in one place.
 *
 * Each feature is independently optional, but each one has combinations that
 * are *worse than not configuring it at all* — a Stripe key with no webhook
 * secret means invoices that can never be marked paid; a Resend key with no
 * webhook secret means bounces that never suppress an address and a sending
 * domain that degrades. Those half-configurations are what this catches.
 *
 * Pure and env-injectable, so `npm run preflight` can fail a deploy on the same
 * rules the doctor reports and the tests assert. No I/O, no Supabase, no
 * network — it answers "is this set of variables coherent", nothing else.
 */

export type Env = Record<string, string | undefined>;

export type Level = 'fail' | 'warn' | 'ok';

export interface Finding {
  level: Level;
  area: string;
  detail: string;
  fix?: string;
}

/**
 * Variables that must never carry a `NEXT_PUBLIC_` prefix.
 *
 * That prefix compiles the value into the browser bundle. For any of these it
 * means handing every visitor the keys: full database access, somebody's
 * calendar, the ability to move money, or the ability to send mail as the
 * agency.
 */
export const NEVER_PUBLIC = [
  'SUPABASE_SERVICE_ROLE_KEY',
  'GOOGLE_CLIENT_SECRET',
  'CALENDAR_TOKEN_KEY',
  'CALENDAR_SYNC_SECRET',
  'CALENDAR_WEBHOOK_SECRET',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'RESEND_API_KEY',
  'RESEND_WEBHOOK_SECRET',
  'TWILIO_AUTH_TOKEN',
  'OUTREACH_RUN_SECRET',
  'LEAD_SYNC_SECRET',
  'SENTRY_AUTH_TOKEN'
];

function has(env: Env, name: string): boolean {
  return Boolean(env[name] && env[name]!.trim());
}

/** Base64 or base64url, decoded length in bytes. */
function decodedBytes(value: string): number {
  return Buffer.from(value.trim().replace(/-/g, '+').replace(/_/g, '/'), 'base64').length;
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

function checkCore(env: Env, out: Finding[]): void {
  for (const name of ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY']) {
    if (!has(env, name)) {
      out.push({ level: 'fail', area: 'Supabase', detail: `${name} is not set`, fix: 'The CRM cannot start without it.' });
    }
  }
  if (!has(env, 'SUPABASE_SERVICE_ROLE_KEY')) {
    out.push({
      level: 'fail',
      area: 'Supabase',
      detail: 'SUPABASE_SERVICE_ROLE_KEY is not set',
      fix: 'The lead sync, the calendar sync, the Stripe webhook and the outreach engine all need it.'
    });
  }

  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  if (url && !/^https:\/\//.test(url)) {
    out.push({
      level: 'fail',
      area: 'Supabase',
      detail: 'NEXT_PUBLIC_SUPABASE_URL is not https',
      fix: 'Session cookies and the service-role key would travel in the clear.'
    });
  }

  // The anon key is a JWT with the role baked in. Pasting the service key into
  // the anon slot is a catastrophic, easy, and completely silent mistake: the
  // app works perfectly and RLS stops applying to the browser.
  const anon = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (anon && looksLikeServiceRoleJwt(anon)) {
    out.push({
      level: 'fail',
      area: 'Supabase',
      detail: 'NEXT_PUBLIC_SUPABASE_ANON_KEY contains a service_role token',
      fix: 'Every visitor has full database access. Rotate it now and paste the anon key instead.'
    });
  }
}

/** Read the `role` claim out of a Supabase JWT without verifying it. */
export function looksLikeServiceRoleJwt(token: string): boolean {
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8')) as {
      role?: string;
    };
    return payload.role === 'service_role';
  } catch {
    return false;
  }
}

function checkExposure(env: Env, out: Finding[]): void {
  const leaked = Object.keys(env).filter(
    (name) => name.startsWith('NEXT_PUBLIC_') && NEVER_PUBLIC.some((secret) => name.includes(secret))
  );
  if (leaked.length) {
    out.push({
      level: 'fail',
      area: 'Secrets',
      detail: `Compiled into the browser bundle: ${leaked.join(', ')}`,
      fix: 'Rotate every one of them, then rename without the NEXT_PUBLIC_ prefix.'
    });
  } else {
    out.push({ level: 'ok', area: 'Secrets', detail: 'No secret carries a NEXT_PUBLIC_ prefix' });
  }
}

function checkDeployTarget(env: Env, out: Finding[]): void {
  if (env.GITHUB_PAGES === 'true') {
    out.push({
      level: 'fail',
      area: 'Build',
      detail: 'GITHUB_PAGES=true forces a static export',
      fix: 'The CRM is server-rendered per request. Unset it.'
    });
  }
}

function checkCalendar(env: Env, out: Finding[]): void {
  const id = has(env, 'GOOGLE_CLIENT_ID');
  const secret = has(env, 'GOOGLE_CLIENT_SECRET');

  if (!id && !secret) {
    out.push({ level: 'ok', area: 'Calendar', detail: 'Not configured (optional)' });
    return;
  }
  if (id !== secret) {
    out.push({
      level: 'fail',
      area: 'Calendar',
      detail: 'Only one of GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET is set',
      fix: 'Set both, or neither.'
    });
    return;
  }

  if (!has(env, 'CALENDAR_TOKEN_KEY')) {
    out.push({
      level: 'fail',
      area: 'Calendar',
      detail: 'CALENDAR_TOKEN_KEY is not set',
      fix: 'Consent would succeed and then fail to store the tokens: openssl rand -base64 32'
    });
  } else if (decodedBytes(env.CALENDAR_TOKEN_KEY!) !== 32) {
    out.push({
      level: 'fail',
      area: 'Calendar',
      detail: `CALENDAR_TOKEN_KEY decodes to ${decodedBytes(env.CALENDAR_TOKEN_KEY!)} bytes, not 32`,
      fix: 'openssl rand -base64 32'
    });
  } else {
    out.push({ level: 'ok', area: 'Calendar', detail: 'Configured, token key valid' });
  }
}

function checkStripe(env: Env, out: Finding[]): void {
  if (!has(env, 'STRIPE_SECRET_KEY')) {
    out.push({ level: 'ok', area: 'Stripe', detail: 'Not configured (optional)' });
    return;
  }

  if (!has(env, 'STRIPE_WEBHOOK_SECRET')) {
    out.push({
      level: 'fail',
      area: 'Stripe',
      detail: 'STRIPE_SECRET_KEY is set but STRIPE_WEBHOOK_SECRET is not',
      fix: 'Nothing will ever be marked paid: the frontend cannot set payment status, so the webhook is the only writer.'
    });
  } else if (!env.STRIPE_WEBHOOK_SECRET!.startsWith('whsec_')) {
    out.push({
      level: 'warn',
      area: 'Stripe',
      detail: 'STRIPE_WEBHOOK_SECRET does not start with whsec_',
      fix: 'The endpoint signing secret is not the API key.'
    });
  }

  const live = env.STRIPE_SECRET_KEY!.startsWith('sk_live_');
  out.push({
    level: 'ok',
    area: 'Stripe',
    detail: live ? 'Live mode — real money' : 'Test mode'
  });
}

function checkOutreach(env: Env, out: Finding[]): void {
  const email = has(env, 'RESEND_API_KEY');
  const sms = has(env, 'TWILIO_ACCOUNT_SID') && has(env, 'TWILIO_AUTH_TOKEN');

  if (!email && !sms) {
    out.push({ level: 'ok', area: 'Outreach', detail: 'No sending provider (optional)' });
    return;
  }

  if (email && !has(env, 'RESEND_WEBHOOK_SECRET')) {
    out.push({
      level: 'fail',
      area: 'Outreach',
      detail: 'RESEND_API_KEY is set but RESEND_WEBHOOK_SECRET is not',
      fix: 'Bounces and complaints would never suppress an address, and replies would not stop sequences.'
    });
  }

  // Unsubscribe links have to keep working for months after a message was sent.
  // Derived from the request origin, they would point at whichever preview
  // deployment happened to send — an unsubscribe link that 404s is the worst
  // kind of broken.
  if (!has(env, 'NEXT_PUBLIC_SITE_URL')) {
    out.push({
      level: 'fail',
      area: 'Outreach',
      detail: 'NEXT_PUBLIC_SITE_URL is not set',
      fix: 'Every marketing email needs an unsubscribe link that keeps working. Set it to the production domain.'
    });
  } else if (!/^https:\/\//.test(env.NEXT_PUBLIC_SITE_URL!)) {
    out.push({
      level: 'fail',
      area: 'Outreach',
      detail: 'NEXT_PUBLIC_SITE_URL is not https',
      fix: 'Unsubscribe tokens would travel in the clear.'
    });
  }

  if (sms && !has(env, 'TWILIO_WEBHOOK_URL')) {
    out.push({
      level: 'warn',
      area: 'Outreach',
      detail: 'TWILIO_WEBHOOK_URL is not set',
      fix: 'Twilio signs the URL from its console; behind a proxy, verification fails without it.'
    });
  }

  out.push({
    level: 'ok',
    area: 'Outreach',
    detail: [email ? 'email' : null, sms ? 'SMS' : null].filter(Boolean).join(' + ')
  });
}

function checkSecretStrength(env: Env, out: Finding[]): void {
  const shared: [string, string][] = [
    ['LEAD_SYNC_SECRET', 'the lead import endpoint'],
    ['CALENDAR_SYNC_SECRET', 'scheduled calendar syncing'],
    ['OUTREACH_RUN_SECRET', 'the outreach run endpoint']
  ];

  for (const [name, what] of shared) {
    const value = env[name];
    if (!value) continue;
    if (value.length < 24) {
      out.push({
        level: 'warn',
        area: 'Secrets',
        detail: `${name} is only ${value.length} characters`,
        fix: `It is the only thing guarding ${what}: openssl rand -hex 32`
      });
    }
  }
}

function checkMonitoring(env: Env, out: Finding[]): void {
  if (has(env, 'SENTRY_DSN') || has(env, 'NEXT_PUBLIC_SENTRY_DSN')) {
    out.push({ level: 'ok', area: 'Monitoring', detail: 'Sentry configured' });
  } else {
    out.push({
      level: 'warn',
      area: 'Monitoring',
      detail: 'No SENTRY_DSN — errors go to the runtime log only',
      fix: 'Cron-driven work has nobody watching it; a failing engine looks like an idle one.'
    });
  }
}

/**
 * Every finding, worst first.
 *
 * A `fail` means do not deploy this. A `warn` means it will work but somebody
 * will be surprised later.
 */
export function inspectEnv(env: Env = process.env): Finding[] {
  const out: Finding[] = [];
  checkCore(env, out);
  checkExposure(env, out);
  checkDeployTarget(env, out);
  checkCalendar(env, out);
  checkStripe(env, out);
  checkOutreach(env, out);
  checkSecretStrength(env, out);
  checkMonitoring(env, out);

  const rank: Record<Level, number> = { fail: 0, warn: 1, ok: 2 };
  return out.sort((a, b) => rank[a.level] - rank[b.level]);
}

export function hasFailures(findings: Finding[]): boolean {
  return findings.some((finding) => finding.level === 'fail');
}

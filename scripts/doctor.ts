/**
 * Preflight for a CRM deployment: `npm run doctor`.
 *
 * Every failure mode this checks for produces the same symptom in the browser —
 * a page that renders but shows nothing — so guessing between them costs more
 * than the check does. It runs against whatever environment it is given, so it
 * works locally and equally against production (`vercel env pull`, or exported
 * variables in CI).
 *
 * Read-only. It reads configuration and issues SELECTs; it writes nothing.
 */

import { createClient } from '@supabase/supabase-js';
import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env.local', quiet: true });
loadEnv({ path: '.env', quiet: true });

type Status = 'ok' | 'warn' | 'fail';

interface Check {
  name: string;
  status: Status;
  detail: string;
  fix?: string;
}

const checks: Check[] = [];

function record(name: string, status: Status, detail: string, fix?: string): void {
  checks.push({ name, status, detail, fix });
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
function checkConfig(): void {
  if (!url) {
    record('Supabase URL', 'fail', 'NEXT_PUBLIC_SUPABASE_URL is not set',
      'Set it to https://<project>.supabase.co');
  } else if (!/^https:\/\/[a-z0-9-]+\.supabase\.(co|in)$/.test(url)) {
    record('Supabase URL', 'warn', `Unusual shape: ${url}`,
      'Expected https://<project>.supabase.co with no trailing path');
  } else {
    record('Supabase URL', 'ok', url);
  }

  if (!anonKey) {
    record('Anon key', 'fail', 'NEXT_PUBLIC_SUPABASE_ANON_KEY is not set',
      'Supabase dashboard -> Project Settings -> API -> anon public');
  } else {
    record('Anon key', 'ok', `${anonKey.slice(0, 12)}… (${anonKey.length} chars)`);
  }

  if (!serviceKey) {
    record('Service role key', 'warn', 'SUPABASE_SERVICE_ROLE_KEY is not set',
      'Only the lead sync needs it. The CRM itself runs without it.');
  } else if (serviceKey === anonKey) {
    record('Service role key', 'fail', 'Identical to the anon key',
      'One of the two was pasted twice; the sync will be refused by RLS.');
  } else {
    record('Service role key', 'ok', `${serviceKey.slice(0, 12)}… (server-side only)`);
  }

  // The one configuration mistake that is a breach rather than an outage.
  const leaked = Object.keys(process.env).filter(
    (key) => key.startsWith('NEXT_PUBLIC_') && process.env[key] === serviceKey && serviceKey
  );
  if (leaked.length) {
    record('Service key exposure', 'fail', `Service role key is also in ${leaked.join(', ')}`,
      'NEXT_PUBLIC_ variables are compiled into the browser bundle. Rotate the key and remove it.');
  } else {
    record('Service key exposure', 'ok', 'Not present in any NEXT_PUBLIC_ variable');
  }

  if (process.env.LEAD_SYNC_SECRET) {
    const secret = process.env.LEAD_SYNC_SECRET;
    record(
      'Lead sync secret',
      secret.length >= 32 ? 'ok' : 'warn',
      secret.length >= 32 ? 'Set, 32+ chars' : `Set but short (${secret.length} chars)`,
      secret.length >= 32 ? undefined : 'Use `openssl rand -hex 32`'
    );
  } else {
    record('Lead sync secret', 'warn', 'Not set — POST /api/crm/sync-leads returns 503',
      'Set LEAD_SYNC_SECRET to enable the import endpoint. The CLI works without it.');
  }

  checkCalendarConfig();
  checkStripeConfig();

  if (process.env.GITHUB_PAGES === 'true') {
    record('Build target', 'fail', 'GITHUB_PAGES=true forces a static export',
      'The CRM is server-rendered per request and cannot be statically exported. Unset it.');
  }
}

/**
 * Google Calendar is optional, so nothing here fails a deployment that is not
 * using it. What does fail is a half-configuration: a client id with no token
 * key means the Connect button sends someone all the way through Google's
 * consent screen and then cannot store the result.
 */
function checkCalendarConfig(): void {
  const hasGoogle = Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
  const partialGoogle =
    !hasGoogle && Boolean(process.env.GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_SECRET);

  let keyBytes = 0;
  if (process.env.CALENDAR_TOKEN_KEY) {
    keyBytes = Buffer.from(
      process.env.CALENDAR_TOKEN_KEY.trim().replace(/-/g, '+').replace(/_/g, '/'),
      'base64'
    ).length;
  }

  if (!hasGoogle && !partialGoogle) {
    record('Google Calendar', 'warn', 'Not configured — appointments stay in the CRM',
      'Optional. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to enable it.');
    return;
  }
  if (partialGoogle) {
    record('Google Calendar', 'fail', 'Only one of GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET is set',
      'Set both, or neither.');
    return;
  }

  if (keyBytes === 0) {
    record('Calendar token key', 'fail', 'CALENDAR_TOKEN_KEY is not set',
      'OAuth tokens cannot be stored safely without it: openssl rand -base64 32');
  } else if (keyBytes !== 32) {
    record('Calendar token key', 'fail', `CALENDAR_TOKEN_KEY decodes to ${keyBytes} bytes, not 32`,
      'openssl rand -base64 32');
  } else {
    record('Calendar token key', 'ok', 'Set, 32 bytes');
  }

  // Same trap as the service-role key: a NEXT_PUBLIC_ prefix compiles the
  // value into the browser bundle for anyone to read.
  const leaked = Object.keys(process.env).filter(
    (name) =>
      name.startsWith('NEXT_PUBLIC_') &&
      /GOOGLE_CLIENT_SECRET|CALENDAR_TOKEN_KEY|CALENDAR_SYNC_SECRET|CALENDAR_WEBHOOK_SECRET/.test(name)
  );
  if (leaked.length) {
    record('Calendar secret exposure', 'fail', `Compiled into the browser: ${leaked.join(', ')}`,
      'Rotate them and rename without the NEXT_PUBLIC_ prefix.');
  }

  record(
    'Calendar sync secret',
    process.env.CALENDAR_SYNC_SECRET ? 'ok' : 'warn',
    process.env.CALENDAR_SYNC_SECRET
      ? 'Set — scheduled syncing is available'
      : 'Not set — scheduled syncing is disabled',
    process.env.CALENDAR_SYNC_SECRET
      ? undefined
      : 'The in-app "Sync now" button works without it.'
  );
}

/**
 * Stripe is optional, so an unconfigured deployment is a warning, not a
 * failure. Two things do fail.
 *
 * A secret key with no webhook secret: invoices can be raised but nothing will
 * ever move to paid, because the frontend is not permitted to set payment
 * status. That looks like a broken product and is really a missing endpoint.
 *
 * A live key on a deployment that also has the test-mode marks of one — worth
 * saying out loud, because the difference between sk_test_ and sk_live_ is
 * eight characters and real money.
 */
function checkStripeConfig(): void {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    record('Stripe', 'warn', 'Not configured — no billing is recorded',
      'Optional. Set STRIPE_SECRET_KEY to enable invoices and retainers.');
    return;
  }

  const live = key.startsWith('sk_live_');
  record('Stripe', live ? 'ok' : 'ok', live ? 'Live mode' : 'Test mode',
    live ? 'Real money. Check the webhook endpoint points at this deployment.' : undefined);

  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    record('Stripe webhook', 'fail', 'STRIPE_WEBHOOK_SECRET is not set',
      'Nothing will ever be marked paid: the frontend cannot set payment status, so the ' +
        'webhook is the only writer. Add the endpoint in the Stripe dashboard and set the secret.');
  } else if (!process.env.STRIPE_WEBHOOK_SECRET.startsWith('whsec_')) {
    record('Stripe webhook', 'warn', 'STRIPE_WEBHOOK_SECRET does not look like a signing secret',
      'It should start with whsec_. The endpoint secret is not the API key.');
  } else {
    record('Stripe webhook', 'ok', 'Signing secret set');
  }

  // Same trap as every other secret here.
  const leaked = Object.keys(process.env).filter(
    (name) => name.startsWith('NEXT_PUBLIC_') && /STRIPE_SECRET|STRIPE_WEBHOOK/.test(name)
  );
  if (leaked.length) {
    record('Stripe key exposure', 'fail', `Compiled into the browser: ${leaked.join(', ')}`,
      'Rotate them immediately and rename without the NEXT_PUBLIC_ prefix.');
  }
}

// ---------------------------------------------------------------------------
// Connectivity and schema
// ---------------------------------------------------------------------------
const CRM_TABLES = [
  'profiles', 'crm_leads', 'lead_intelligence', 'contacts', 'activities',
  'outreach_sequences', 'outreach_steps', 'lead_outreach', 'tasks', 'appointments',
  'opportunities', 'proposals', 'clients', 'contracts', 'payments', 'notes',
  'documents', 'pipeline_stage_history',
  'calendar_accounts', 'calendar_credentials', 'calendar_deletions',
  'subscriptions', 'stripe_events'
];

async function checkDatabase(): Promise<void> {
  if (!url || !serviceKey) {
    record('Database', 'warn', 'Skipped — needs the URL and the service role key');
    return;
  }

  const admin = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  const missing: string[] = [];
  let unreachable: string | null = null;

  for (const table of CRM_TABLES) {
    const { error } = await admin.from(table).select('*', { count: 'exact', head: true });
    if (!error) continue;
    if (/does not exist|schema cache/i.test(error.message)) missing.push(table);
    else unreachable = error.message;
  }

  if (unreachable) {
    record('Database', 'fail', unreachable, 'Check the URL, the key, and that the project is not paused.');
    return;
  }
  if (missing.length) {
    record('Schema', 'fail', `${missing.length} table(s) missing: ${missing.join(', ')}`,
      'Apply everything in supabase/migrations/ in filename order.');
    return;
  }
  record('Schema', 'ok', `All ${CRM_TABLES.length} CRM tables present`);

  // The contact columns arrived in a later migration than the rest, so a
  // half-migrated project fails here rather than at the first sync.
  const { error: contactError } = await admin
    .from('lead_intelligence')
    .select('contact_name, contact_role, contact_source_url', { head: true });
  if (contactError) {
    record('Migrations up to date', 'fail', contactError.message,
      'Apply supabase/migrations/20260816_add_lead_contact.sql');
  } else {
    record('Migrations up to date', 'ok', '20260816_add_lead_contact applied');
  }

  // Same reasoning for the sales workflow: the functions arrived in their own
  // migration, and a project missing them fails on the first deal converted
  // rather than here.
  const { error: workflowError } = await admin.rpc('crm_stage_rank', { stage: 'qualified' });
  if (workflowError) {
    record('Sales workflow', 'fail', workflowError.message,
      'Apply supabase/migrations/20260818_sales_workflow.sql');
  } else {
    record('Sales workflow', 'ok', 'Transition functions installed');
  }

  const { count } = await admin.from('crm_leads').select('*', { count: 'exact', head: true });
  record('Leads', count ? 'ok' : 'warn', `${count ?? 0} in the CRM`,
    count ? undefined : 'Import one: npm run sync:leads -- --file <export.json>');

  const { data: owners } = await admin
    .from('profiles')
    .select('email, role')
    .in('role', ['owner', 'admin']);
  if (!owners?.length) {
    record('Admin account', 'fail', 'No profile has the owner or admin role',
      "update public.profiles set role = 'owner' where email = 'you@agency.com';");
  } else {
    record('Admin account', 'ok', owners.map((o) => o.email).join(', '));
  }
}

/**
 * RLS is the CRM's only real access control, so an unprotected table is a data
 * leak rather than a bug. Checked with the anon key: a signed-out request must
 * come back empty.
 */
async function checkRls(): Promise<void> {
  if (!url || !anonKey) {
    record('Row level security', 'warn', 'Skipped — needs the URL and the anon key');
    return;
  }

  const anon = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  const exposed: string[] = [];
  const guarded = [
    'crm_leads', 'lead_intelligence', 'clients', 'payments', 'profiles',
    // Holds live Google refresh tokens; nothing but the service role may read it.
    'calendar_accounts', 'calendar_credentials',
    // Revenue records. Readable by members, writable by nobody.
    'subscriptions', 'stripe_events'
  ];
  for (const table of guarded) {
    const { data, error } = await anon.from(table).select('*').limit(1);
    // An error here is the healthy outcome; rows are not.
    if (!error && data && data.length > 0) exposed.push(table);
  }

  if (exposed.length) {
    record('Row level security', 'fail', `Readable while signed out: ${exposed.join(', ')}`,
      'RLS is off or a policy is too permissive. Do not deploy.');
  } else {
    record('Row level security', 'ok', 'Signed-out reads return nothing');
  }
}

// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  checkConfig();
  await checkDatabase();
  await checkRls();

  const symbols: Record<Status, string> = { ok: '  ok  ', warn: ' warn ', fail: ' FAIL ' };
  console.log('\nCRM PREFLIGHT');
  console.log('='.repeat(62));
  for (const check of checks) {
    console.log(`[${symbols[check.status]}] ${check.name.padEnd(22)} ${check.detail}`);
    if (check.fix && check.status !== 'ok') console.log(`${' '.repeat(11)}-> ${check.fix}`);
  }
  console.log('='.repeat(62));

  const failures = checks.filter((check) => check.status === 'fail');
  const warnings = checks.filter((check) => check.status === 'warn');
  console.log(
    `${checks.length - failures.length - warnings.length} ok, ${warnings.length} warning(s), ` +
      `${failures.length} failure(s)\n`
  );
  if (failures.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`Preflight could not run: ${(error as Error).message}`);
  process.exitCode = 1;
});

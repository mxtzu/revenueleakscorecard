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

  if (process.env.GITHUB_PAGES === 'true') {
    record('Build target', 'fail', 'GITHUB_PAGES=true forces a static export',
      'The CRM is server-rendered per request and cannot be statically exported. Unset it.');
  }
}

// ---------------------------------------------------------------------------
// Connectivity and schema
// ---------------------------------------------------------------------------
const CRM_TABLES = [
  'profiles', 'crm_leads', 'lead_intelligence', 'contacts', 'activities',
  'outreach_sequences', 'outreach_steps', 'lead_outreach', 'tasks', 'appointments',
  'opportunities', 'proposals', 'clients', 'contracts', 'payments', 'notes',
  'documents', 'pipeline_stage_history'
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
  for (const table of ['crm_leads', 'lead_intelligence', 'clients', 'payments', 'profiles']) {
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

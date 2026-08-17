/**
 * A logical backup of the CRM tables, as JSON.
 *
 * This is NOT the primary backup. Supabase takes daily snapshots on every paid
 * plan and point-in-time recovery on Pro and above, and those restore the whole
 * cluster including auth users, storage metadata and RLS policies — none of
 * which this script captures. See docs/deployment.md.
 *
 * What this is for is the two things a managed snapshot does not give you:
 *
 *   SOMETHING YOU HOLD. A backup that only exists inside the account it is
 *   protecting is not much of a backup. This produces a file you can put
 *   somewhere else.
 *
 *   SOMETHING YOU CAN READ. "Which invoices existed last Tuesday" is answerable
 *   from a JSON file in seconds and from a cluster snapshot in about an hour.
 *
 * Runs with the service role, so it reads past RLS. Treat the output as
 * equivalent to a database dump: it contains every lead, every contact and
 * every message ever sent.
 *
 *   npm run backup -- --out backups/
 *   npm run backup -- --out backups/ --exclude outreach_messages
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { config as loadEnv } from 'dotenv';
import { createClient } from '@supabase/supabase-js';

loadEnv({ path: '.env.local' });
loadEnv();

/**
 * Ordered so a restore can replay them without tripping a foreign key:
 * parents first, children after.
 */
const TABLES = [
  'profiles',
  'crm_leads',
  'lead_intelligence',
  'contacts',
  'activities',
  'outreach_sequences',
  'outreach_steps',
  'lead_outreach',
  'tasks',
  'calendar_accounts',
  'appointments',
  'opportunities',
  'proposals',
  'clients',
  'contracts',
  'subscriptions',
  'payments',
  'notes',
  'documents',
  'pipeline_stage_history',
  'suppressions',
  'outreach_messages',
  'inbound_messages',
  'outreach_settings'
];

/**
 * Never exported.
 *
 * `calendar_credentials` holds OAuth tokens for somebody's whole calendar, and
 * they are encrypted with a key this file would not contain — so the rows would
 * be useless to a restore and dangerous in a backup directory. The event
 * ledgers are reconstructible from the providers and are pure noise here.
 */
const NEVER_EXPORT = ['calendar_credentials', 'stripe_events', 'provider_events'];

const PAGE = 1000;

function arg(name: string): string | undefined {
  const match = process.argv.find((value) => value.startsWith(`--${name}=`));
  if (match) return match.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    console.error('Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY first.');
    process.exit(2);
  }

  const outDir = arg('out') ?? 'backups';
  const excluded = new Set([...NEVER_EXPORT, ...(arg('exclude')?.split(',') ?? [])]);

  const admin = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  mkdirSync(outDir, { recursive: true });

  const payload: Record<string, unknown[]> = {};
  const counts: Record<string, number> = {};
  let failed = 0;

  for (const table of TABLES) {
    if (excluded.has(table)) continue;

    const rows: unknown[] = [];
    let from = 0;

    // Paged, because a Supabase select caps at 1000 rows by default and a
    // backup that silently stops at a thousand leads is worse than none.
    for (;;) {
      const { data, error } = await admin.from(table).select('*').range(from, from + PAGE - 1);
      if (error) {
        console.error(`  ! ${table}: ${error.message}`);
        failed += 1;
        break;
      }
      rows.push(...(data ?? []));
      if (!data || data.length < PAGE) break;
      from += PAGE;
    }

    payload[table] = rows;
    counts[table] = rows.length;
    console.log(`  ${String(rows.length).padStart(6)}  ${table}`);
  }

  const file = join(outDir, `crm-${stamp}.json`);
  writeFileSync(
    file,
    JSON.stringify(
      {
        exported_at: new Date().toISOString(),
        project_url: url,
        note: 'Logical export. Excludes calendar_credentials and the webhook ledgers. Not a substitute for Supabase PITR.',
        counts,
        tables: payload
      },
      null,
      2
    )
  );

  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  console.log(`\n${total} rows → ${file}`);

  if (failed > 0) {
    console.error(`\n${failed} table(s) could not be read. This backup is incomplete.`);
    process.exit(1);
  }
  if (total === 0) {
    // An empty file that looks like a backup is worse than a failure.
    console.error('\nNothing was exported. Check the key and the project URL.');
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

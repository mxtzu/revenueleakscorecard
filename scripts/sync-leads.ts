/**
 * CLI: import a lead_pipeline JSON export into the CRM.
 *
 *   npm run sync:leads -- --file lead_pipeline/output/leads.json
 *   npm run sync:leads -- --file leads.json --min-score 60 --dry-run
 *
 * Runs with the service role, so it must only ever be run from a trusted
 * machine or CI — never from the browser, and never with the key in a
 * NEXT_PUBLIC_ variable.
 *
 * Safe to re-run. See src/lib/crm/sync.ts for the idempotency contract: a
 * second run refreshes lead_intelligence and leaves every CRM decision
 * (stage, owner, tasks, opportunities, clients, payments) untouched.
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';

import { createServiceClient, isServiceRoleConfigured } from '../src/lib/crm/supabase';
import {
  formatSyncResult,
  parseExportDocument,
  syncLeads,
  toIntelligenceRow,
  type PipelineLeadExport
} from '../src/lib/crm/sync';
import { PIPELINE_STAGES, type PipelineStage } from '../src/lib/crm/types';

loadEnv({ path: '.env.local', quiet: true });
loadEnv({ path: '.env', quiet: true });

interface Args {
  file: string;
  minScore: number;
  stage: PipelineStage;
  dryRun: boolean;
  limit: number | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    file: '',
    minScore: 0,
    stage: 'qualified',
    dryRun: false,
    limit: null
  };

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];

    switch (flag) {
      case '--file':
      case '-f':
        args.file = value ?? '';
        i += 1;
        break;
      case '--min-score':
        args.minScore = Number(value);
        i += 1;
        break;
      case '--stage':
        if (!PIPELINE_STAGES.includes(value as PipelineStage)) {
          fail(`--stage must be one of: ${PIPELINE_STAGES.join(', ')}`);
        }
        args.stage = value as PipelineStage;
        i += 1;
        break;
      case '--limit':
        args.limit = Number(value);
        i += 1;
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--help':
      case '-h':
        printUsage();
        process.exit(0);
        break;
      default:
        fail(`Unknown argument: ${flag}`);
    }
  }

  if (!args.file) fail('--file is required. Point it at a pipeline JSON export.');
  if (!Number.isFinite(args.minScore)) fail('--min-score must be a number.');
  if (args.limit !== null && !Number.isFinite(args.limit)) fail('--limit must be a number.');
  return args;
}

function printUsage(): void {
  console.log(
    [
      'Usage: npm run sync:leads -- --file <export.json> [options]',
      '',
      '  --file, -f <path>    lead_pipeline JSON export (required)',
      '  --min-score <n>      skip leads scoring below n (default 0)',
      `  --stage <stage>      stage for newly created leads (default qualified)`,
      '  --limit <n>          only process the first n leads',
      '  --dry-run            parse and map, write nothing',
      '',
      'Produce an export with:',
      '  python pipeline.py --export-only --format json --output leads.json'
    ].join('\n')
  );
}

function fail(message: string): never {
  console.error(`Error: ${message}\n`);
  printUsage();
  process.exit(1);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const path = resolve(process.cwd(), args.file);

  let leads: PipelineLeadExport[];
  try {
    leads = parseExportDocument(JSON.parse(await readFile(path, 'utf8')));
  } catch (error) {
    fail(`Could not read ${path}: ${(error as Error).message}`);
  }

  if (args.limit !== null) leads = leads.slice(0, args.limit);
  console.log(`Read ${leads.length} lead(s) from ${path}`);

  if (args.dryRun) {
    const mapped = leads.map((lead) => toIntelligenceRow(lead));
    const withScore = mapped.filter((row) => (row.lead_score ?? 0) >= args.minScore);
    console.log(
      [
        'DRY RUN — nothing written.',
        `  Would import:  ${withScore.length}`,
        `  Below min score (${args.minScore}): ${mapped.length - withScore.length}`,
        '',
        'First mapped row:',
        JSON.stringify(withScore[0] ?? mapped[0] ?? null, null, 2)
      ].join('\n')
    );
    return;
  }

  if (!isServiceRoleConfigured()) {
    fail(
      'Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL) ' +
        'and SUPABASE_SERVICE_ROLE_KEY in .env.local — see .env.example.'
    );
  }

  const result = await syncLeads(createServiceClient(), leads, {
    minScore: args.minScore,
    initialStage: args.stage
  });

  console.log(formatSyncResult(result));
  if (result.errors.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`Lead sync failed: ${(error as Error).message}`);
  process.exitCode = 1;
});

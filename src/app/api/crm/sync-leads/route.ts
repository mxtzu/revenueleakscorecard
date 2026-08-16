/**
 * POST /api/crm/sync-leads
 *
 * Machine endpoint for importing a lead_pipeline export. Exists so the sync can
 * later be automated (a scheduled job, a runner posting after a scrape) without
 * anyone needing shell access to the CRM database.
 *
 * Auth is a shared secret in `LEAD_SYNC_SECRET`, not a user session: the caller
 * is a job, not a person, and the handler runs with the service role. If the
 * secret is unset the route refuses every request rather than defaulting open.
 *
 * The route is a thin wrapper — all the idempotency rules live in
 * src/lib/crm/sync.ts and apply identically to the CLI.
 */

import { NextRequest, NextResponse } from 'next/server';

import { createServiceClient, isServiceRoleConfigured } from '@/lib/crm/supabase';
import { parseExportDocument, syncLeads } from '@/lib/crm/sync';
import { PIPELINE_STAGES, type PipelineStage } from '@/lib/crm/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Length-independent comparison so the response time leaks nothing. */
function secretMatches(provided: string | null): boolean {
  const expected = process.env.LEAD_SYNC_SECRET;
  if (!expected || !provided) return false;
  if (provided.length !== expected.length) return false;

  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) {
    diff |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  }
  return diff === 0;
}

function bearer(request: NextRequest): string | null {
  const header = request.headers.get('authorization');
  if (header?.startsWith('Bearer ')) return header.slice(7);
  return request.headers.get('x-lead-sync-secret');
}

export async function POST(request: NextRequest) {
  if (!process.env.LEAD_SYNC_SECRET) {
    return NextResponse.json(
      { ok: false, error: 'Lead sync is not enabled on this deployment.' },
      { status: 503 }
    );
  }
  if (!secretMatches(bearer(request))) {
    return NextResponse.json({ ok: false, error: 'Unauthorised.' }, { status: 401 });
  }
  if (!isServiceRoleConfigured()) {
    return NextResponse.json(
      { ok: false, error: 'Supabase service role is not configured.' },
      { status: 503 }
    );
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON.' }, { status: 400 });
  }

  let leads;
  try {
    leads = parseExportDocument(payload);
  } catch (error) {
    return NextResponse.json({ ok: false, error: (error as Error).message }, { status: 400 });
  }

  const url = new URL(request.url);
  const minScoreParam = url.searchParams.get('min_score');
  const minScore = minScoreParam === null ? 0 : Number(minScoreParam);
  if (!Number.isFinite(minScore)) {
    return NextResponse.json({ ok: false, error: 'min_score must be a number.' }, { status: 400 });
  }

  const stageParam = url.searchParams.get('stage');
  if (stageParam && !PIPELINE_STAGES.includes(stageParam as PipelineStage)) {
    return NextResponse.json(
      { ok: false, error: `stage must be one of: ${PIPELINE_STAGES.join(', ')}` },
      { status: 400 }
    );
  }

  try {
    const result = await syncLeads(createServiceClient(), leads, {
      minScore,
      initialStage: (stageParam as PipelineStage) ?? 'qualified'
    });
    return NextResponse.json({ ok: true, result }, { status: result.errors.length ? 207 : 200 });
  } catch (error) {
    console.error('Lead sync failed', error);
    return NextResponse.json({ ok: false, error: (error as Error).message }, { status: 500 });
  }
}

import { NextRequest, NextResponse } from 'next/server';

import { syncLeads, parseExportDocument } from '@/lib/crm/sync';
import { requireWriter } from '@/lib/crm/server';
import { PIPELINE_STAGES, type PipelineStage } from '@/lib/crm/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_FILE_BYTES = 10 * 1024 * 1024;

/**
 * Human-facing lead import endpoint.
 *
 * Unlike /api/crm/sync-leads, this route uses the signed-in CRM session and
 * RLS rather than the machine-only LEAD_SYNC_SECRET. It is intended for the
 * Leads page so an operator can upload the JSON export produced by the Python
 * lead pipeline without shell access.
 */
export async function POST(request: NextRequest) {
  try {
    const { client } = await requireWriter();
    const form = await request.formData();
    const file = form.get('file');

    if (!(file instanceof File)) {
      return NextResponse.json({ ok: false, error: 'Choose a JSON export file.' }, { status: 400 });
    }

    if (file.size > MAX_FILE_BYTES) {
      return NextResponse.json(
        { ok: false, error: 'File is too large. The maximum import size is 10 MB.' },
        { status: 413 }
      );
    }

    const text = await file.text();
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      return NextResponse.json(
        { ok: false, error: 'The selected file is not valid JSON.' },
        { status: 400 }
      );
    }

    let leads;
    try {
      leads = parseExportDocument(payload);
    } catch (error) {
      return NextResponse.json({ ok: false, error: (error as Error).message }, { status: 400 });
    }

    const minScoreRaw = String(form.get('min_score') ?? '').trim();
    const minScore = minScoreRaw ? Number(minScoreRaw) : 0;
    if (!Number.isFinite(minScore) || minScore < 0 || minScore > 100) {
      return NextResponse.json(
        { ok: false, error: 'Minimum score must be a number between 0 and 100.' },
        { status: 400 }
      );
    }

    const stageRaw = String(form.get('stage') ?? 'qualified');
    if (!PIPELINE_STAGES.includes(stageRaw as PipelineStage)) {
      return NextResponse.json(
        { ok: false, error: `Stage must be one of: ${PIPELINE_STAGES.join(', ')}` },
        { status: 400 }
      );
    }

    const result = await syncLeads(client, leads, {
      minScore,
      initialStage: stageRaw as PipelineStage
    });

    return NextResponse.json({ ok: true, result }, { status: result.errors.length ? 207 : 200 });
  } catch (error) {
    console.error('Interactive lead import failed', error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'Lead import failed.' },
      { status: 500 }
    );
  }
}

/**
 * Pipeline board — one column per active stage.
 *
 * Read-only columns: dragging cards between stages is a UI affordance that
 * hides the reason for the move, and the reason is what the loss/disqualified
 * reports depend on. Stage changes happen on the lead page, where the form asks
 * for one.
 */

import Link from 'next/link';

import { Badge, EmptyState, PageHeader, ScoreBadge } from '@/components/crm/ui';
import { formatRelative, orDash } from '@/lib/crm/format';
import { listLeads } from '@/lib/crm/queries';
import { crmClient } from '@/lib/crm/server';
import {
  ACTIVE_PIPELINE_STAGES,
  CLOSED_PIPELINE_STAGES,
  PIPELINE_STAGE_LABELS,
  type CrmLeadWithIntelligence,
  type PipelineStage
} from '@/lib/crm/types';

export const dynamic = 'force-dynamic';

function Column({ stage, leads }: { stage: PipelineStage; leads: CrmLeadWithIntelligence[] }) {
  return (
    <div className="flex w-72 shrink-0 flex-col rounded-xl border border-line bg-ink-900/50">
      <div className="flex items-center justify-between border-b border-line-soft px-4 py-3">
        <span className="text-sm font-medium text-white/85">{PIPELINE_STAGE_LABELS[stage]}</span>
        <Badge>{leads.length}</Badge>
      </div>
      <div className="flex-1 space-y-2 p-2">
        {leads.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs text-white/25">Empty</p>
        ) : (
          leads.map((lead) => (
            <Link
              key={lead.id}
              href={`/leads/${lead.id}`}
              className="block rounded-lg border border-line-soft bg-ink-900 px-3 py-2.5 transition-colors hover:border-electric-500/40"
            >
              <div className="flex items-start justify-between gap-2">
                <span className="min-w-0 flex-1 truncate text-sm text-white">
                  {lead.intelligence?.company_name ?? lead.external_lead_id}
                </span>
                <ScoreBadge score={lead.intelligence?.lead_score} />
              </div>
              <p className="mt-1 truncate text-xs text-white/35">
                {orDash(lead.intelligence?.city)} · {formatRelative(lead.updated_at)}
              </p>
              {lead.next_action ? (
                <p className="mt-1.5 truncate text-xs text-electric-300">→ {lead.next_action}</p>
              ) : null}
            </Link>
          ))
        )}
      </div>
    </div>
  );
}

export default async function PipelinePage() {
  const leads = await listLeads(crmClient(), { limit: 500 });

  const byStage = new Map<PipelineStage, CrmLeadWithIntelligence[]>();
  for (const lead of leads) {
    const bucket = byStage.get(lead.pipeline_stage) ?? [];
    bucket.push(lead);
    byStage.set(lead.pipeline_stage, bucket);
  }

  const closedCount = CLOSED_PIPELINE_STAGES.filter((stage) => stage !== 'won').reduce(
    (total, stage) => total + (byStage.get(stage)?.length ?? 0),
    0
  );

  return (
    <>
      <PageHeader
        eyebrow="Sales"
        title="Pipeline"
        description="Every open lead by stage. Move a lead from its detail page, where the reason gets recorded."
      />

      {leads.length === 0 ? (
        <EmptyState
          title="The pipeline is empty"
          description="Sync a pipeline export to populate it: npm run sync:leads -- --file <export.json>"
        />
      ) : (
        <>
          <div className="-mx-5 flex gap-3 overflow-x-auto px-5 pb-4 lg:-mx-8 lg:px-8">
            {ACTIVE_PIPELINE_STAGES.map((stage) => (
              <Column key={stage} stage={stage} leads={byStage.get(stage) ?? []} />
            ))}
          </div>
          {closedCount > 0 ? (
            <p className="mt-4 text-xs text-white/35">
              {closedCount} lead{closedCount === 1 ? '' : 's'} closed as lost, disqualified or do
              not contact —{' '}
              <Link href="/leads?stage=lost" className="text-electric-300 hover:underline">
                view in the lead list
              </Link>
              .
            </p>
          ) : null}
        </>
      )}
    </>
  );
}

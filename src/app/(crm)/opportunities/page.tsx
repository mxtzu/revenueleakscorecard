/**
 * Opportunities — deals in progress and what they are worth.
 *
 * Two totals, kept apart on purpose: the face value of every open deal, and
 * the same figure weighted by each deal's stated probability. Reporting only
 * the first is how a pipeline gets talked about as if it were revenue.
 */

import Link from 'next/link';

import {
  Badge,
  Card,
  Cell,
  EmptyState,
  PageHeader,
  Row,
  StatCard,
  Table
} from '@/components/crm/ui';
import { formatDate, formatMoney, humanise, orDash } from '@/lib/crm/format';
import { listOpportunities } from '@/lib/crm/queries';
import { crmClient } from '@/lib/crm/server';
import type { Opportunity, OpportunityStage } from '@/lib/crm/types';

export const dynamic = 'force-dynamic';

const STAGE_TONE: Record<OpportunityStage, 'neutral' | 'info' | 'warning' | 'positive' | 'danger'> = {
  discovery: 'neutral',
  sales_call: 'info',
  proposal: 'warning',
  negotiation: 'warning',
  won: 'positive',
  lost: 'danger'
};

/** Total contract value: recurring across the term, plus anything one-off. */
function contractValue(opportunity: Opportunity): number {
  const recurring = Number(opportunity.monthly_value ?? 0) * (opportunity.contract_months ?? 1);
  return recurring + Number(opportunity.setup_fee ?? 0) + Number(opportunity.one_time_value ?? 0);
}

export default async function OpportunitiesPage() {
  const opportunities = await listOpportunities(crmClient(), 300);

  const open = opportunities.filter((item) => item.stage !== 'won' && item.stage !== 'lost');
  const won = opportunities.filter((item) => item.stage === 'won');

  const openValue = open.reduce((total, item) => total + contractValue(item), 0);
  const weighted = open.reduce(
    (total, item) => total + (contractValue(item) * (item.probability ?? 100)) / 100,
    0
  );
  const wonValue = won.reduce((total, item) => total + contractValue(item), 0);
  const monthlyRecurring = won.reduce((total, item) => total + Number(item.monthly_value ?? 0), 0);

  return (
    <>
      <PageHeader
        eyebrow="Revenue"
        title="Opportunities"
        description="Deals attached to leads, valued over the contract term."
      />

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Open value" value={formatMoney(openValue)} hint={`${open.length} open`} />
        <StatCard
          label="Weighted"
          value={formatMoney(weighted)}
          hint="Open value × probability"
        />
        <StatCard label="Won value" value={formatMoney(wonValue)} hint={`${won.length} won`} />
        <StatCard label="Won MRR" value={formatMoney(monthlyRecurring)} hint="Monthly, from won deals" />
      </div>

      <Card title={`${opportunities.length} opportunit${opportunities.length === 1 ? 'y' : 'ies'}`}>
        {opportunities.length === 0 ? (
          <EmptyState
            title="No opportunities"
            description="An opportunity is created against a lead once a deal is in play."
          />
        ) : (
          <Table
            head={['Opportunity', 'Stage', 'Service', 'Monthly', 'Contract value', 'Prob.', 'Close date']}
          >
            {opportunities.map((opportunity) => (
              <Row key={opportunity.id}>
                <Cell>
                  <Link
                    href={`/leads/${opportunity.crm_lead_id}`}
                    className="font-medium text-white hover:text-electric-300"
                  >
                    {opportunity.name}
                  </Link>
                </Cell>
                <Cell>
                  <Badge tone={STAGE_TONE[opportunity.stage]}>{humanise(opportunity.stage)}</Badge>
                </Cell>
                <Cell className="text-white/50">{orDash(opportunity.service_name)}</Cell>
                <Cell className="font-mono text-white/75">
                  {formatMoney(opportunity.monthly_value)}
                </Cell>
                <Cell className="font-mono text-white/75">
                  {formatMoney(contractValue(opportunity))}
                </Cell>
                <Cell className="text-white/50">
                  {opportunity.probability === null ? '—' : `${opportunity.probability}%`}
                </Cell>
                <Cell className="whitespace-nowrap text-white/45">
                  {formatDate(opportunity.expected_close_date)}
                </Cell>
              </Row>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}

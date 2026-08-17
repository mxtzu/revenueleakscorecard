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
import { OpportunityForm, ProposalForm } from '@/components/crm/entityForms';
import {
  LoseDealForm,
  SendProposalForm,
  WinDealForm
} from '@/components/crm/workflowForms';
import { ActionError, DeleteForm, Disclosure, ReadOnlyNotice } from '@/components/crm/forms';
import { formatDate, formatMoney, humanise, orDash } from '@/lib/crm/format';
import { canWrite, isAdmin } from '@/lib/crm/permissions';
import {
  listAssignableProfiles,
  listLeads,
  listOpportunities,
  listProposals
} from '@/lib/crm/queries';
import { crmSession } from '@/lib/crm/server';
import type { Opportunity, OpportunityStage } from '@/lib/crm/types';

import { removeOpportunity, saveOpportunity } from '../_actions/crud';
import { removeProposal, saveProposal } from '../_actions/records';
import { markLost, markWon, sendProposal } from '../_actions/workflow';

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

export default async function OpportunitiesPage({
  searchParams
}: {
  /** `highlight` is set by the convert action, to find the new deal in a long table. */
  searchParams?: { error?: string; highlight?: string };
}) {
  const { client, profile } = await crmSession();
  const [opportunities, team, leads, proposals] = await Promise.all([
    listOpportunities(client, 300),
    listAssignableProfiles(client),
    listLeads(client, { limit: 300 }),
    listProposals(client, 500)
  ]);

  // Grouped once rather than queried per row: a proposal list per opportunity
  // would be one round trip each.
  const proposalsByOpportunity = new Map<string, typeof proposals>();
  for (const proposal of proposals) {
    const bucket = proposalsByOpportunity.get(proposal.opportunity_id) ?? [];
    bucket.push(proposal);
    proposalsByOpportunity.set(proposal.opportunity_id, bucket);
  }

  const writable = canWrite(profile);
  const deletable = isAdmin(profile);
  const people = team.map((member) => ({
    value: member.id,
    label: member.full_name ?? member.email ?? 'Unnamed'
  }));
  const leadOptions = leads.map((lead) => ({
    value: lead.id,
    label: lead.intelligence?.company_name ?? lead.external_lead_id
  }));
  const leadName = new Map(leadOptions.map((option) => [option.value, option.label]));

  const open = opportunities.filter((item) => item.stage !== 'won' && item.stage !== 'lost');
  const won = opportunities.filter((item) => item.stage === 'won');

  // How many live deals each lead has, so the lose form can say truthfully
  // whether closing this one would also close the lead.
  const openByLead = new Map<string, number>();
  for (const deal of open) {
    openByLead.set(deal.crm_lead_id, (openByLead.get(deal.crm_lead_id) ?? 0) + 1);
  }

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

      <ActionError message={searchParams?.error} />

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

      <Card className="mb-4">
        {writable ? (
          <Disclosure summary="Create an opportunity" tone="primary">
            <OpportunityForm
              action={saveOpportunity}
              returnTo="/opportunities"
              leads={leadOptions}
              people={people}
            />
          </Disclosure>
        ) : (
          <ReadOnlyNotice what="create opportunities" />
        )}
      </Card>

      <Card title={`${opportunities.length} opportunit${opportunities.length === 1 ? 'y' : 'ies'}`}>
        {opportunities.length === 0 ? (
          <EmptyState
            title="No opportunities"
            description="An opportunity is created against a lead once a deal is in play."
          />
        ) : (
          <Table
            head={[
              'Opportunity', 'Stage', 'Service', 'Monthly', 'Contract value', 'Prob.',
              'Close date', ''
            ]}
          >
            {opportunities.map((opportunity) => (
              <Row
                key={opportunity.id}
                className={
                  opportunity.id === searchParams?.highlight
                    ? 'bg-electric-500/5 ring-1 ring-inset ring-electric-500/30'
                    : ''
                }
              >
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
                <Cell>
                  {writable ? (
                    <div className="flex min-w-[120px] flex-col items-start gap-1.5">
                      <Disclosure summary="Edit">
                        <div className="min-w-[320px] py-2">
                          <OpportunityForm
                            action={saveOpportunity}
                            returnTo="/opportunities"
                            opportunity={opportunity}
                            people={people}
                          />
                        </div>
                      </Disclosure>

                      <Disclosure
                        summary={`Proposals (${proposalsByOpportunity.get(opportunity.id)?.length ?? 0})`}
                      >
                        <div className="min-w-[320px] space-y-3 py-2">
                          {(proposalsByOpportunity.get(opportunity.id) ?? []).map((proposal) => (
                            <div
                              key={proposal.id}
                              className="rounded-lg border border-line-soft px-3 py-2.5"
                            >
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-sm text-white/85">
                                  v{proposal.version} {proposal.title ?? ''}
                                </span>
                                <Badge
                                  tone={proposal.status === 'accepted' ? 'positive' : 'neutral'}
                                >
                                  {humanise(proposal.status)}
                                </Badge>
                              </div>
                              <p className="mt-1 text-xs text-white/40">
                                {formatMoney(proposal.total_value)} · valid to{' '}
                                {formatDate(proposal.valid_until)}
                              </p>
                              {proposal.document_url ? (
                                <a
                                  href={proposal.document_url}
                                  target="_blank"
                                  rel="noopener noreferrer nofollow"
                                  className="mt-1 inline-block text-xs text-electric-300 hover:underline"
                                >
                                  Open document
                                </a>
                              ) : null}
                              <div className="mt-2 space-y-2 border-t border-line-soft pt-2">
                                {proposal.status === 'draft' || proposal.status === 'sent' ? (
                                  <Disclosure
                                    summary={proposal.sent_at ? 'Re-send' : 'Mark as sent'}
                                    tone="primary"
                                  >
                                    <SendProposalForm
                                      action={sendProposal}
                                      proposal={proposal}
                                      returnTo="/opportunities"
                                      leadId={opportunity.crm_lead_id}
                                    />
                                  </Disclosure>
                                ) : null}
                                <Disclosure summary="Edit">
                                  <ProposalForm
                                    action={saveProposal}
                                    returnTo="/opportunities"
                                    opportunityId={opportunity.id}
                                    proposal={proposal}
                                  />
                                </Disclosure>
                                <DeleteForm
                                  action={removeProposal}
                                  id={proposal.id}
                                  hidden={{ return_to: '/opportunities' }}
                                  label="Delete"
                                  warning="Proposal versions are a record of what was offered and when."
                                  allowed={deletable}
                                />
                              </div>
                            </div>
                          ))}
                          <Disclosure summary="New proposal" tone="primary">
                            <ProposalForm
                              action={saveProposal}
                              returnTo="/opportunities"
                              opportunityId={opportunity.id}
                            />
                          </Disclosure>
                        </div>
                      </Disclosure>
                      {opportunity.stage === 'lost' ? null : (
                        <Disclosure
                          summary={opportunity.stage === 'won' ? 'Create the account' : 'Mark won'}
                          tone="primary"
                        >
                          <div className="min-w-[320px] py-2">
                            <WinDealForm
                              action={markWon}
                              opportunity={opportunity}
                              returnTo="/opportunities"
                              companyName={
                                leadName.get(opportunity.crm_lead_id) ?? opportunity.name
                              }
                              people={people}
                            />
                          </div>
                        </Disclosure>
                      )}

                      {opportunity.stage === 'won' || opportunity.stage === 'lost' ? null : (
                        <Disclosure summary="Mark lost" tone="danger">
                          <div className="min-w-[320px] py-2">
                            <LoseDealForm
                              action={markLost}
                              opportunity={opportunity}
                              returnTo="/opportunities"
                              otherOpenDeals={
                                (openByLead.get(opportunity.crm_lead_id) ?? 1) - 1
                              }
                            />
                          </div>
                        </Disclosure>
                      )}
                      <DeleteForm
                        action={removeOpportunity}
                        id={opportunity.id}
                        hidden={{ return_to: '/opportunities' }}
                        label="Delete"
                        warning="Deleting an opportunity also deletes its proposals. A lost deal is better recorded as lost."
                        allowed={deletable}
                      />
                    </div>
                  ) : null}
                </Cell>
              </Row>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}

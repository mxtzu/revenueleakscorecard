/**
 * The sales call workspace.
 *
 * A single page to have the call from, because the alternative is four tabs
 * and a notepad. Two columns:
 *
 *   left   — what the pipeline found out, arranged as things to say. Read-only.
 *   right  — the notes, the outcome and the follow-up, in one form that saves
 *            as one transaction.
 *
 * Deliberately not the lead page with a form bolted on. The lead page is for
 * browsing a record; this is for the twenty minutes you are on the phone, and
 * everything that is not useful during those twenty minutes is left off.
 */

import Link from 'next/link';
import { notFound } from 'next/navigation';

import {
  AdvertisingBadge,
  Badge,
  Card,
  EmptyState,
  ExternalLink,
  Field,
  FieldGrid,
  PageHeader,
  ScoreBadge,
  StageBadge
} from '@/components/crm/ui';
import { ActionError, Disclosure, ReadOnlyNotice } from '@/components/crm/forms';
import {
  CallOutcomeForm,
  ConvertLeadForm,
  contactOptions
} from '@/components/crm/workflowForms';
import {
  displayUrl,
  formatDate,
  formatDateTime,
  formatMoney,
  formatRelative,
  humanise,
  orDash
} from '@/lib/crm/format';
import { canWrite } from '@/lib/crm/permissions';
import { getLeadDetail, listAssignableProfiles } from '@/lib/crm/queries';
import { crmSession } from '@/lib/crm/server';
import { isClosedStage } from '@/lib/crm/workflow';

import { convertLead, saveCall } from '../../../_actions/workflow';

export const dynamic = 'force-dynamic';

/** Activity types worth glancing at mid-call; the rest is noise on this page. */
const CONVERSATION_TYPES = new Set(['call', 'email', 'meeting', 'sms', 'note']);

export default async function SalesCallPage({
  params,
  searchParams
}: {
  params: { id: string };
  searchParams?: { error?: string };
}) {
  const { client, profile } = await crmSession();
  const [lead, team] = await Promise.all([
    getLeadDetail(client, params.id),
    listAssignableProfiles(client)
  ]);
  if (!lead) notFound();

  const intel = lead.intelligence;
  const company = intel?.company_name ?? lead.external_lead_id;
  const writable = canWrite(profile);
  const returnTo = `/leads/${lead.id}/call`;

  const openDeals = lead.opportunities.filter(
    (deal) => deal.stage !== 'won' && deal.stage !== 'lost'
  );
  const people = team.map((member) => ({
    value: member.id,
    label: member.full_name ?? member.email ?? 'Unnamed'
  }));

  const recent = lead.activities
    .filter((activity) => CONVERSATION_TYPES.has(activity.type))
    .slice(0, 6);

  // The pipeline's own findings, phrased as openers. `opportunities` and
  // `strengths` are exactly the two halves of a discovery call: what is wrong,
  // and what is already working and worth saying out loud first.
  const gaps = intel?.opportunities ?? [];
  const strengths = intel?.strengths ?? [];

  return (
    <>
      <PageHeader
        eyebrow="Sales call"
        title={company}
        description={
          intel?.business_phone
            ? `Call ${intel.business_phone}${intel.contact_name ? ` — ask for ${intel.contact_name}` : ''}`
            : 'No phone number was published for this business.'
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
        <StageBadge stage={lead.pipeline_stage} />
        <ScoreBadge score={intel?.lead_score} />
        {intel?.advertising_status ? (
          <AdvertisingBadge status={intel.advertising_status} />
        ) : null}
        <Link href={`/leads/${lead.id}`} className="text-white/45 hover:text-electric-300">
          Full record →
        </Link>
      </div>

      <ActionError message={searchParams?.error} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        {/* ---------------------------------------------------------------- */}
        {/* Left: what to say                                                 */}
        {/* ---------------------------------------------------------------- */}
        <div className="space-y-4">
          <Card title="Who you are calling">
            <FieldGrid>
              <Field label="Phone">
                {intel?.business_phone ? (
                  <a href={`tel:${intel.business_phone}`} className="text-electric-300 hover:underline">
                    {intel.business_phone}
                  </a>
                ) : (
                  '—'
                )}
              </Field>
              <Field label="Decision maker">
                {intel?.contact_name ? (
                  <>
                    {intel.contact_name}
                    {intel.contact_role ? (
                      <span className="text-white/40"> · {intel.contact_role}</span>
                    ) : null}
                  </>
                ) : (
                  '—'
                )}
              </Field>
              <Field label="Website">
                {intel?.website ? (
                  <ExternalLink href={intel.website}>{displayUrl(intel.website)}</ExternalLink>
                ) : (
                  '—'
                )}
              </Field>
              <Field label="Where">{orDash(intel?.city ?? intel?.address)}</Field>
              <Field label="Trade">{orDash(intel?.niche ? humanise(intel.niche) : null)}</Field>
              <Field label="Google">
                {intel?.google_rating
                  ? `${intel.google_rating} from ${intel.google_review_count ?? 0} reviews`
                  : '—'}
              </Field>
            </FieldGrid>

            {lead.contacts.length > 0 ? (
              <ul className="mt-3 space-y-1.5 border-t border-line-soft pt-3 text-sm">
                {lead.contacts.map((contact) => (
                  <li key={contact.id} className="flex flex-wrap items-baseline gap-2">
                    <span className="text-white/85">{contact.full_name}</span>
                    {contact.job_title ? (
                      <span className="text-xs text-white/40">{contact.job_title}</span>
                    ) : null}
                    {contact.is_primary ? <Badge tone="info">Primary</Badge> : null}
                    {contact.phone ? (
                      <a href={`tel:${contact.phone}`} className="text-xs text-electric-300">
                        {contact.phone}
                      </a>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </Card>

          <Card
            title="What to open with"
            description="Found by the pipeline. Say the strength first — it is the difference between a critique and a conversation."
          >
            {strengths.length === 0 && gaps.length === 0 ? (
              <EmptyState
                title="No analysis"
                description="The pipeline recorded no strengths or gaps for this business. A website check would give you something to open with."
              />
            ) : (
              <div className="space-y-4">
                {strengths.length > 0 ? (
                  <div>
                    <p className="label-mono mb-2 text-emerald-300/60">Working already</p>
                    <ul className="space-y-1.5 text-sm text-white/70">
                      {strengths.map((item) => (
                        <li key={item} className="flex gap-2">
                          <span className="text-emerald-400/60">+</span>
                          {item}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {gaps.length > 0 ? (
                  <div>
                    <p className="label-mono mb-2 text-amber-300/60">Costing them money</p>
                    <ul className="space-y-1.5 text-sm text-white/70">
                      {gaps.map((item) => (
                        <li key={item} className="flex gap-2">
                          <span className="text-amber-400/60">→</span>
                          {item}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
            )}

            {intel?.lead_reason ? (
              <p className="mt-4 border-t border-line-soft pt-3 text-sm text-white/55">
                <span className="label-mono mr-2 text-white/35">Why they scored</span>
                {intel.lead_reason}
              </p>
            ) : null}
            {intel?.recommended_service ? (
              <p className="mt-2 text-sm text-white/55">
                <span className="label-mono mr-2 text-white/35">Pitch</span>
                {humanise(intel.recommended_service)}
              </p>
            ) : null}
          </Card>

          <Card title="Where you left it">
            {recent.length === 0 ? (
              <EmptyState title="First contact" description="Nothing has been logged with this lead yet." />
            ) : (
              <ul className="space-y-2.5 text-sm">
                {recent.map((activity) => (
                  <li key={activity.id} className="border-l-2 border-line pl-3">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <span className="text-white/80">{activity.subject ?? humanise(activity.type)}</span>
                      <span className="text-xs text-white/35">
                        {humanise(activity.direction)} · {formatRelative(activity.occurred_at)}
                      </span>
                    </div>
                    {activity.body ? (
                      <p className="mt-0.5 line-clamp-3 text-xs text-white/45">{activity.body}</p>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            {lead.next_action ? (
              <p className="mt-3 border-t border-line-soft pt-3 text-sm text-white/60">
                <span className="label-mono mr-2 text-white/35">You said you would</span>
                {lead.next_action}
                {lead.next_action_at ? (
                  <span className="text-white/35"> · by {formatDateTime(lead.next_action_at)}</span>
                ) : null}
              </p>
            ) : null}
          </Card>
        </div>

        {/* ---------------------------------------------------------------- */}
        {/* Right: what happened                                              */}
        {/* ---------------------------------------------------------------- */}
        <div className="space-y-4">
          <Card title="The call">
            {writable ? (
              <CallOutcomeForm
                action={saveCall}
                leadId={lead.id}
                returnTo={returnTo}
                contacts={contactOptions(lead.contacts)}
                opportunities={lead.opportunities.map((deal) => ({
                  value: deal.id,
                  label: `${deal.name} · ${humanise(deal.stage)}`
                }))}
              />
            ) : (
              <ReadOnlyNotice what="log calls" />
            )}
          </Card>

          {openDeals.length > 0 ? (
            <Card title="Deals in play">
              <ul className="space-y-2 text-sm">
                {openDeals.map((deal) => (
                  <li key={deal.id} className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-white/80">{deal.name}</span>
                    <span className="text-xs text-white/40">
                      {humanise(deal.stage)} · {formatMoney(deal.monthly_value)}/mo
                      {deal.expected_close_date
                        ? ` · closes ${formatDate(deal.expected_close_date)}`
                        : ''}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-3 border-t border-line-soft pt-3 text-xs text-white/40">
                Won and lost are decided on the{' '}
                <Link href="/opportunities" className="text-electric-300 hover:underline">
                  opportunities page
                </Link>
                , where the numbers are in front of you.
              </p>
            </Card>
          ) : null}

          {writable && !isClosedStage(lead.pipeline_stage) ? (
            <Card
              title="Turn this into a deal"
              description="Once there is something real to quote for."
            >
              <Disclosure summary="Open an opportunity" tone="primary" open={openDeals.length === 0}>
                <ConvertLeadForm
                  action={convertLead}
                  leadId={lead.id}
                  returnTo={returnTo}
                  companyName={company}
                  contacts={contactOptions(lead.contacts)}
                  people={people}
                  defaults={{
                    service_name: intel?.recommended_service
                      ? humanise(intel.recommended_service)
                      : null
                  }}
                />
              </Disclosure>
            </Card>
          ) : null}
        </div>
      </div>
    </>
  );
}

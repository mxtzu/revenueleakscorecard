/**
 * The outreach console.
 *
 * This is the one page in the CRM that can cause a stranger to be contacted, so
 * it is laid out around that fact rather than around the templates: the state
 * of the sending switch comes first, then who is currently enrolled, then what
 * actually went out, then who must never be written to again.
 *
 * The send log includes refusals with their reasons. "Why did this lead never
 * get step 3" is the question an outreach tool is most often asked, and a log
 * that only records successes cannot answer it.
 */

import { SequenceForm, StepForm } from '@/components/crm/entityForms';
import {
  ActionError,
  ActionNotice,
  DeleteForm,
  Disclosure,
  ReadOnlyNotice
} from '@/components/crm/forms';
import { Badge, Card, EmptyState, PageHeader, StatCard, Table } from '@/components/crm/ui';
import {
  EnrolmentRow,
  MessageRow,
  OutreachSettingsForm,
  SendingStatus,
  SuppressForm,
  SuppressionRow
} from '@/components/crm/outreachPanels';
import { formatRelative, humanise } from '@/lib/crm/format';
import { canWrite, isAdmin } from '@/lib/crm/permissions';
import { listLeads, listOutreachSequences, listOutreachSteps } from '@/lib/crm/queries';
import { crmSession } from '@/lib/crm/server';
import { isEmailConfigured, isSmsConfigured } from '@/lib/outreach/config';
import {
  getOutreachSettings,
  listEnrolments,
  listOutreachMessages,
  listSuppressions,
  sentTodayCount
} from '@/lib/outreach/queries';

import { removeSequence, removeStep, saveSequence, saveStep } from '../_actions/records';
import {
  runOutreachNow,
  saveOutreachSettings,
  setEnrolmentStatus,
  suppressAddress,
  unsuppressAddress
} from '../_actions/outreach';

export const dynamic = 'force-dynamic';

const HERE = '/outreach';

/** A delay in minutes, said the way a person would say it. */
function describeDelay(minutes: number): string {
  if (minutes === 0) return 'immediately';
  if (minutes < 60) return `after ${minutes} min`;
  if (minutes < 60 * 24) {
    const hours = Math.round((minutes / 60) * 10) / 10;
    return `after ${hours} hour${hours === 1 ? '' : 's'}`;
  }
  const days = Math.round((minutes / 60 / 24) * 10) / 10;
  return `after ${days} day${days === 1 ? '' : 's'}`;
}

export default async function OutreachPage({
  searchParams
}: {
  searchParams?: { error?: string; notice?: string };
}) {
  const { client, profile } = await crmSession();
  const [sequences, steps, settings, enrolments, messages, suppressions, leads, sentToday] =
    await Promise.all([
      listOutreachSequences(client),
      listOutreachSteps(client),
      getOutreachSettings(client),
      listEnrolments(client),
      listOutreachMessages(client, 100),
      listSuppressions(client),
      listLeads(client, { limit: 500 }),
      sentTodayCount(client)
    ]);

  const writable = canWrite(profile);
  const deletable = isAdmin(profile);
  const admin = isAdmin(profile);

  const leadName = new Map(
    leads.map((lead) => [lead.id, lead.intelligence?.company_name ?? lead.external_lead_id])
  );
  const sequenceName = new Map(sequences.map((sequence) => [sequence.id, sequence.name]));
  const liveEnrolments = enrolments.filter((row) => row.status === 'active');
  const repliedCount = enrolments.filter((row) => row.status === 'replied').length;

  const stepsBySequence = new Map<string, typeof steps>();
  for (const step of steps) {
    const bucket = stepsBySequence.get(step.sequence_id) ?? [];
    bucket.push(step);
    stepsBySequence.set(step.sequence_id, bucket);
  }

  return (
    <>
      <PageHeader
        eyebrow="Outreach"
        title="Outreach"
        description="Sequences, who is enrolled, what went out, and who must not be contacted."
      />

      <ActionError message={searchParams?.error} />
      <ActionNotice message={searchParams?.notice} />

      <SendingStatus
        settings={settings}
        emailConfigured={isEmailConfigured()}
        smsConfigured={isSmsConfigured()}
        sentToday={sentToday}
        isAdminUser={admin}
        runAction={runOutreachNow}
      />

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Live enrolments" value={String(liveEnrolments.length)} />
        <StatCard label="Sent today" value={String(sentToday)} />
        <StatCard label="Replied" value={String(repliedCount)} hint="Sequence stopped itself" />
        <StatCard
          label="Do not contact"
          value={String(suppressions.length)}
          hint="Suppressed addresses"
        />
      </div>

      {admin && settings ? (
        <Card className="mb-4">
          <Disclosure summary="Sending settings" open={!settings.sending_enabled}>
            <OutreachSettingsForm action={saveOutreachSettings} settings={settings} />
          </Disclosure>
        </Card>
      ) : null}

      <Card
        title={`${enrolments.length} enrolment${enrolments.length === 1 ? '' : 's'}`}
        description="A lead is enrolled by a person, from that lead's page."
        className="mb-4"
      >
        {enrolments.length === 0 ? (
          <EmptyState
            title="Nobody is enrolled"
            description="Open a lead and enrol it in a sequence."
          />
        ) : (
          <Table head={['Lead', 'Sequence', 'Status', 'Step', 'Next', '']}>
            {enrolments.map((enrolment) => (
              <EnrolmentRow
                key={enrolment.id}
                enrolment={enrolment}
                leadName={leadName.get(enrolment.crm_lead_id) ?? 'Unknown lead'}
                sequenceName={sequenceName.get(enrolment.sequence_id) ?? 'Unknown sequence'}
                writable={writable}
                returnTo={HERE}
                onSetStatus={setEnrolmentStatus}
              />
            ))}
          </Table>
        )}
      </Card>

      <Card
        title="Send log"
        description="Everything the engine sent, and everything it refused to send, with the reason."
        className="mb-4"
      >
        {messages.length === 0 ? (
          <EmptyState title="Nothing sent yet" />
        ) : (
          <Table head={['When', 'Lead', 'Channel', 'Step', 'Status', 'Detail']}>
            {messages.map((entry) => (
              <MessageRow
                key={entry.id}
                message={entry}
                leadName={entry.crm_lead_id ? (leadName.get(entry.crm_lead_id) ?? '—') : '—'}
              />
            ))}
          </Table>
        )}
      </Card>

      <Card
        title={`Do not contact (${suppressions.length})`}
        description="Unsubscribes, bounces and spam complaints. Checked before every single send."
        className="mb-4"
      >
        {writable ? (
          <Disclosure summary="Add an address">
            <SuppressForm action={suppressAddress} returnTo={HERE} />
          </Disclosure>
        ) : null}

        {suppressions.length === 0 ? (
          <p className="mt-3 text-xs text-white/35">Nobody has opted out.</p>
        ) : (
          <div className="mt-3">
            <Table head={['Address', 'Reason', 'Source', 'Added', '']}>
              {suppressions.map((entry) => (
                <SuppressionRow
                  key={entry.id}
                  entry={entry}
                  deletable={deletable}
                  returnTo={HERE}
                  onRemove={unsuppressAddress}
                />
              ))}
            </Table>
          </div>
        )}
      </Card>

      <Card className="mb-4">
        {writable ? (
          <Disclosure summary="Create a sequence" tone="primary">
            <SequenceForm action={saveSequence} returnTo={HERE} />
          </Disclosure>
        ) : (
          <ReadOnlyNotice what="create sequences" />
        )}
      </Card>

      {sequences.length === 0 ? (
        <EmptyState
          title="No sequences yet"
          description="A sequence is a named set of messages in order — the thing you would hand to someone doing outreach by hand."
        />
      ) : (
        <div className="space-y-4">
          {sequences.map((sequence) => {
            const sequenceSteps = stepsBySequence.get(sequence.id) ?? [];
            return (
              <Card
                key={sequence.id}
                title={sequence.name}
                description={sequence.description ?? undefined}
                actions={
                  <Badge tone={sequence.active ? 'positive' : 'neutral'}>
                    {sequence.active ? 'Active' : 'Inactive'}
                  </Badge>
                }
              >
                {sequenceSteps.length === 0 ? (
                  <EmptyState title="No steps yet" />
                ) : (
                  <ol className="space-y-2">
                    {sequenceSteps.map((step) => (
                      <li key={step.id} className="rounded-lg border border-line-soft px-3 py-2.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-mono text-xs text-white/40">
                            {String(step.step_number).padStart(2, '0')}
                          </span>
                          <Badge tone="info">{humanise(step.channel)}</Badge>
                          <span className="text-xs text-white/45">
                            {describeDelay(step.delay_minutes)}
                          </span>
                          {!step.active ? <Badge>Paused</Badge> : null}
                        </div>
                        {step.subject_template ? (
                          <p className="mt-1.5 text-sm text-white/85">{step.subject_template}</p>
                        ) : null}
                        {step.body_template ? (
                          <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-xs text-white/50">
                            {step.body_template}
                          </p>
                        ) : null}

                        {writable ? (
                          <div className="mt-2.5 space-y-2 border-t border-line-soft pt-2.5">
                            <Disclosure summary="Edit step">
                              <StepForm
                                action={saveStep}
                                returnTo={HERE}
                                sequenceId={sequence.id}
                                step={step}
                              />
                            </Disclosure>
                            <DeleteForm
                              action={removeStep}
                              id={step.id}
                              hidden={{ return_to: HERE }}
                              label="Delete step"
                              warning="Later steps keep their numbers, so there will be a gap in the sequence."
                              allowed={deletable}
                            />
                          </div>
                        ) : null}
                      </li>
                    ))}
                  </ol>
                )}

                <div className="mt-4 space-y-2 border-t border-line-soft pt-4">
                  {writable ? (
                    <>
                      <Disclosure summary="Add a step" tone="primary">
                        <StepForm action={saveStep} returnTo={HERE} sequenceId={sequence.id} />
                      </Disclosure>
                      <Disclosure summary="Edit sequence">
                        <SequenceForm action={saveSequence} returnTo={HERE} sequence={sequence} />
                      </Disclosure>
                      <DeleteForm
                        action={removeSequence}
                        id={sequence.id}
                        hidden={{ return_to: HERE }}
                        label="Delete sequence"
                        warning="Every step is deleted with it. A sequence that is no longer used is better marked inactive — and one a lead is enrolled in cannot be deleted at all."
                        allowed={deletable}
                      />
                    </>
                  ) : (
                    <ReadOnlyNotice what="edit sequences" />
                  )}
                  <p className="text-xs text-white/25">
                    Created {formatRelative(sequence.created_at)}
                  </p>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}

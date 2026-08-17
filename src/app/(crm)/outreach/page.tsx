/**
 * Outreach sequences — the message templates, and nothing that sends them.
 *
 * This page exists so the schema does not need re-cutting when the sending
 * engine is built: sequences, their ordered steps, the channel, the delay and
 * the templates are all editable here, and `lead_outreach` already records
 * enrolment state.
 *
 * What is deliberately absent, and why the page says so out loud: there is no
 * enrol button and no send. The original brief put the outreach engine on the
 * do-not-build list, and a "Start sequence" control that quietly did nothing —
 * or worse, quietly did something — is the wrong way to represent that.
 *
 * The one thing that already writes `lead_outreach` is the
 * `halt_outreach_on_inbound_reply` trigger. Enrolment state is therefore shown
 * read-only on the lead page rather than here.
 */

import { SequenceForm, StepForm } from '@/components/crm/entityForms';
import { ActionError, DeleteForm, Disclosure, ReadOnlyNotice } from '@/components/crm/forms';
import { Badge, Card, EmptyState, PageHeader } from '@/components/crm/ui';
import { formatRelative, humanise } from '@/lib/crm/format';
import { canWrite, isAdmin } from '@/lib/crm/permissions';
import { listOutreachSequences, listOutreachSteps } from '@/lib/crm/queries';
import { crmSession } from '@/lib/crm/server';

import { removeSequence, removeStep, saveSequence, saveStep } from '../_actions/records';

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
  searchParams?: { error?: string };
}) {
  const { client, profile } = await crmSession();
  const [sequences, steps] = await Promise.all([
    listOutreachSequences(client),
    listOutreachSteps(client)
  ]);

  const writable = canWrite(profile);
  const deletable = isAdmin(profile);

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
        title="Sequences"
        description="Message templates and their order. Writing them here does not send them."
      />

      <ActionError message={searchParams?.error} />

      <div className="mb-4 rounded-lg border border-amber-400/20 bg-amber-400/5 px-4 py-3 text-xs leading-relaxed text-amber-200/80">
        Nothing on this page contacts anyone. There is no enrol button and no send — the sending
        engine is deliberately not built. What is here is the structure a future engine would read:
        sequences, ordered steps, channel, delay and templates. A lead&apos;s enrolment state, if
        anything ever sets it, appears on that lead&apos;s own page.
      </div>

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

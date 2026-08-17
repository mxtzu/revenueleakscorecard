/**
 * Lead detail — the page a salesperson works from.
 *
 * Four blocks, in the order they get used:
 *
 *   1. CRM state      — stage, owner, next action. Editable.
 *   2. Business intel — everything lead_pipeline found. Read-only, by design:
 *                       it is a synced replica, and an edit here would be
 *                       silently overwritten on the next sync. The sync is the
 *                       only writer, enforced by RLS rather than by convention.
 *   3. Contacts       — who to talk to.
 *   4. Timeline       — what has already happened.
 */

import Link from 'next/link';
import { notFound } from 'next/navigation';

import { AnalysisGrid } from '@/components/crm/AnalysisGrid';
import {
  AdvertisingBadge,
  Badge,
  Card,
  Cell,
  EmptyState,
  ExternalLink,
  Field,
  FieldGrid,
  PageHeader,
  Row,
  ScoreBadge,
  StageBadge,
  Table
} from '@/components/crm/ui';
import {
  displayUrl,
  formatDate,
  formatDateTime,
  formatMoney,
  formatRelative,
  humanise,
  orDash
} from '@/lib/crm/format';
import {
  AppointmentForm,
  ContactForm,
  NoteForm,
  OpportunityForm,
  TaskForm
} from '@/components/crm/entityForms';
import { ActionError, DeleteForm, Disclosure, ReadOnlyNotice } from '@/components/crm/forms';
import {
  removeAppointment,
  removeContact,
  removeNote,
  removeOpportunity,
  removeTask,
  saveAppointment,
  saveContact,
  saveNote,
  saveOpportunity,
  saveTask
} from '../../_actions/crud';
import { noteText } from '@/lib/crm/mutations';
import { canWrite, isAdmin } from '@/lib/crm/permissions';
import { getLeadDetail, listAssignableProfiles } from '@/lib/crm/queries';
import { crmSession } from '@/lib/crm/server';
import { PIPELINE_STAGES, PIPELINE_STAGE_LABELS } from '@/lib/crm/types';

import { addNote, changeStage, logCommunication } from './actions';

export const dynamic = 'force-dynamic';

const inputClass =
  'w-full rounded-lg border border-line bg-ink-800 px-3 py-2 text-sm text-white placeholder:text-white/25';

export default async function LeadDetailPage({
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

  const here = `/leads/${params.id}`;
  const people = team.map((member) => ({
    value: member.id,
    label: member.full_name ?? member.email ?? 'Unnamed'
  }));
  const contactOptions = lead.contacts.map((contact) => ({
    value: contact.id,
    label: contact.full_name ?? 'Unnamed'
  }));

  // Hiding forms a role cannot submit is presentation only; the server action
  // re-checks and RLS refuses regardless. Deletion is admin-only in RLS, so it
  // gets the narrower gate.
  const writable = canWrite(profile);
  const deletable = isAdmin(profile);

  const info = lead.intelligence;
  const name = info?.company_name ?? lead.external_lead_id;
  const socials: [string, string][] = info
    ? ([
        ['Google Maps', info.google_maps_url],
        ['Facebook', info.facebook_url],
        ['Instagram', info.instagram_url],
        ['LinkedIn', info.linkedin_url],
        ['TikTok', info.tiktok_url],
        ['YouTube', info.youtube_url]
      ] as [string, string | null][])
        .filter((entry): entry is [string, string] => Boolean(entry[1]))
    : [];

  return (
    <>
      <PageHeader
        eyebrow={info?.niche ? humanise(info.niche) : 'Lead'}
        title={name}
        description={info?.lead_reason ?? undefined}
        actions={
          <>
            <ScoreBadge score={info?.lead_score} />
            <StageBadge stage={lead.pipeline_stage} />
          </>
        }
      />

      <ActionError message={searchParams?.error} />

      {!writable ? (
        <p className="mb-4 rounded-lg border border-line bg-white/[0.02] px-4 py-2.5 text-xs text-white/45">
          Read-only: your role cannot change stages or log activity.
        </p>
      ) : null}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        {/* ---------------------------------------------------------------- */}
        {/* 1. CRM state                                                      */}
        {/* ---------------------------------------------------------------- */}
        <Card title="CRM state" description="Sales progress. Owned by your team, never by the sync.">
          <FieldGrid>
            <Field label="Stage">
              <StageBadge stage={lead.pipeline_stage} />
            </Field>
            <Field label="Owner">{orDash(lead.owner?.full_name ?? lead.owner?.email)}</Field>
            <Field label="Next action">{orDash(lead.next_action)}</Field>
            <Field label="Next action at">{formatDateTime(lead.next_action_at)}</Field>
            <Field label="First contacted">{formatDateTime(lead.first_contacted_at)}</Field>
            <Field label="First replied">{formatDateTime(lead.first_replied_at)}</Field>
            <Field label="Converted">{formatDateTime(lead.converted_at)}</Field>
            <Field label="In CRM since">{formatDate(lead.created_at)}</Field>
          </FieldGrid>

          {lead.loss_reason ? (
            <p className="mt-4 rounded-lg border border-rose-400/20 bg-rose-400/5 px-3 py-2 text-xs text-rose-200">
              Lost: {lead.loss_reason}
            </p>
          ) : null}
          {lead.disqualification_reason ? (
            <p className="mt-4 rounded-lg border border-rose-400/20 bg-rose-400/5 px-3 py-2 text-xs text-rose-200">
              Disqualified: {lead.disqualification_reason}
            </p>
          ) : null}

          {writable ? (
          <form action={changeStage} className="mt-5 space-y-3 border-t border-line-soft pt-4">
            <input type="hidden" name="lead_id" value={lead.id} />
            <label className="block">
              <span className="label-mono text-white/40">Move to stage</span>
              <select name="stage" defaultValue={lead.pipeline_stage} className={`mt-1.5 ${inputClass}`}>
                {PIPELINE_STAGES.map((stage) => (
                  <option key={stage} value={stage}>
                    {PIPELINE_STAGE_LABELS[stage]}
                  </option>
                ))}
              </select>
            </label>
            <input
              type="text"
              name="reason"
              placeholder="Reason (recorded when losing or disqualifying)"
              className={inputClass}
            />
            <button
              type="submit"
              className="rounded-lg bg-electric-500 px-4 py-2 text-sm font-medium text-white hover:bg-electric-600"
            >
              Update stage
            </button>
          </form>
          ) : null}
        </Card>

        {/* ---------------------------------------------------------------- */}
        {/* 2. Business intelligence                                          */}
        {/* ---------------------------------------------------------------- */}
        <Card
          title="Business intelligence"
          description="Synced from the lead pipeline. Read-only — the next sync would overwrite an edit."
          className="xl:col-span-2"
        >
          {!info ? (
            <EmptyState
              title="No intelligence synced"
              description="This CRM lead has no matching pipeline record yet. Run the sync to attach one."
            />
          ) : (
            <>
              <FieldGrid>
                <Field label="Trading name">{orDash(info.trading_name)}</Field>
                <Field label="Legal name">{orDash(info.legal_name)}</Field>
                <Field label="Niche">{humanise(info.niche)}</Field>
                <Field label="Website">
                  {info.website ? (
                    <ExternalLink href={info.website}>{displayUrl(info.website)}</ExternalLink>
                  ) : (
                    'No website found'
                  )}
                </Field>
                <Field label="Phone">{orDash(info.business_phone)}</Field>
                <Field label="Email">{orDash(info.business_email)}</Field>
                <Field label="Published contact">
                  {info.contact_name ? (
                    <>
                      {info.contact_name}
                      {info.contact_role ? (
                        <span className="text-white/45"> · {info.contact_role}</span>
                      ) : null}
                      {info.contact_source_url ? (
                        <>
                          {' '}
                          <ExternalLink href={info.contact_source_url}>source</ExternalLink>
                        </>
                      ) : null}
                    </>
                  ) : (
                    'Not published'
                  )}
                </Field>
                <Field label="Address">{orDash(info.address)}</Field>
                <Field label="City">{orDash(info.city)}</Field>
                <Field label="Postcode">{orDash(info.postcode)}</Field>
                <Field label="Google rating">
                  {info.google_rating === null
                    ? '—'
                    : `${info.google_rating} (${info.google_review_count ?? 0} reviews)`}
                </Field>
                <Field label="Company number">{orDash(info.company_number)}</Field>
                <Field label="Years trading">
                  {info.years_in_operation === null ? '—' : info.years_in_operation}
                </Field>
              </FieldGrid>

              <div className="mt-6 grid grid-cols-1 gap-4 border-t border-line-soft pt-5 sm:grid-cols-3">
                <Field label="Lead score">
                  <ScoreBadge score={info.lead_score} />{' '}
                  <span className="text-white/40">{orDash(info.score_band)}</span>
                </Field>
                <Field label="Advertising">
                  <AdvertisingBadge status={info.advertising_status} />
                </Field>
                <Field label="Recommended service">{orDash(info.recommended_service)}</Field>
              </div>

              {info.opportunities.length ? (
                <div className="mt-5">
                  <p className="label-mono mb-2 text-white/35">Opportunities detected</p>
                  <ul className="space-y-1.5">
                    {info.opportunities.map((opportunity) => (
                      <li key={opportunity} className="text-sm text-white/75">
                        · {opportunity}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {info.strengths.length ? (
                <div className="mt-5">
                  <p className="label-mono mb-2 text-white/35">Strengths</p>
                  <div className="flex flex-wrap gap-1.5">
                    {info.strengths.map((strength) => (
                      <Badge key={strength} tone="positive">
                        {strength}
                      </Badge>
                    ))}
                  </div>
                </div>
              ) : null}

              {socials.length ? (
                <div className="mt-5">
                  <p className="label-mono mb-2 text-white/35">Online presence</p>
                  <div className="flex flex-wrap gap-3 text-sm">
                    {socials.map(([platform, url]) => (
                      <ExternalLink key={platform} href={url}>
                        {platform}
                      </ExternalLink>
                    ))}
                  </div>
                </div>
              ) : null}

              <details className="mt-6 border-t border-line-soft pt-4">
                <summary className="cursor-pointer text-sm text-white/55 hover:text-white/80">
                  Website analysis
                </summary>
                <div className="mt-4">
                  <AnalysisGrid data={info.website_analysis} />
                </div>
              </details>

              <details className="mt-3">
                <summary className="cursor-pointer text-sm text-white/55 hover:text-white/80">
                  Advertising analysis
                </summary>
                <div className="mt-4">
                  <AnalysisGrid data={info.advertising_analysis} />
                  <p className="mt-3 text-xs text-white/35">
                    Evidence levels come from the pipeline: only <em>confirmed</em> means a source
                    directly showed active advertising.
                  </p>
                </div>
              </details>

              <details className="mt-3">
                <summary className="cursor-pointer text-sm text-white/55 hover:text-white/80">
                  Score breakdown
                </summary>
                <div className="mt-4">
                  <AnalysisGrid data={info.score_breakdown} />
                </div>
              </details>

              <p className="mt-6 border-t border-line-soft pt-4 text-xs text-white/30">
                Sources: {info.sources.length ? info.sources.join(', ') : 'unrecorded'} · discovered{' '}
                {formatDate(info.date_discovered)} · last synced {formatRelative(info.synced_at)} ·
                pipeline id <span className="font-mono">{info.external_lead_id}</span>
              </p>
            </>
          )}
        </Card>

        {/* ---------------------------------------------------------------- */}
        {/* 3. Contacts                                                       */}
        {/* ---------------------------------------------------------------- */}
        <Card title="Contacts" description="People, added by your team as you learn who they are.">
          {info?.contact_name ? (
            <p className="mb-3 rounded-lg border border-line-soft bg-white/[0.02] px-3 py-2 text-xs text-white/55">
              Research found <span className="text-white/85">{info.contact_name}</span>
              {info.contact_role ? ` (${info.contact_role})` : ''} on the company website. That is a
              synced finding, not a CRM contact — add them below to make it one.
            </p>
          ) : null}

          {lead.contacts.length === 0 ? (
            <EmptyState
              title="No contacts yet"
              description="The pipeline records a decision-maker only where the business publishes one with a stated role; it never guesses a person's name."
            />
          ) : (
            <ul className="space-y-3">
              {lead.contacts.map((contact) => (
                <li key={contact.id} className="rounded-lg border border-line-soft px-3 py-2.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-white">
                      {contact.full_name ??
                        [contact.first_name, contact.last_name].filter(Boolean).join(' ') ??
                        'Unnamed'}
                    </span>
                    {contact.is_primary ? <Badge tone="info">Primary</Badge> : null}
                    {contact.is_decision_maker ? <Badge tone="positive">Decision maker</Badge> : null}
                  </div>
                  <p className="mt-1 text-xs text-white/45">{orDash(contact.job_title)}</p>
                  <p className="mt-1.5 text-xs text-white/60">
                    {orDash(contact.email)} · {orDash(contact.phone)}
                  </p>

                  {writable ? (
                    <div className="mt-2.5 space-y-2 border-t border-line-soft pt-2.5">
                      <Disclosure summary="Edit">
                        <ContactForm
                          action={saveContact}
                          leadId={lead.id}
                          returnTo={here}
                          contact={contact}
                        />
                      </Disclosure>
                      <DeleteForm
                        action={removeContact}
                        id={contact.id}
                        hidden={{ crm_lead_id: lead.id, return_to: here }}
                        label="Delete contact"
                        warning={`${contact.full_name ?? 'This contact'} will be removed permanently. Activities that referenced them are kept.`}
                        allowed={deletable}
                      />
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}

          <div className="mt-4 border-t border-line-soft pt-4">
            {writable ? (
              <Disclosure summary="Add a contact" tone="primary">
                <ContactForm action={saveContact} leadId={lead.id} returnTo={here} />
              </Disclosure>
            ) : (
              <ReadOnlyNotice what="add contacts" />
            )}
          </div>
        </Card>

        {/* ---------------------------------------------------------------- */}
        {/* Opportunities, tasks, appointments and notes for this lead        */}
        {/* ---------------------------------------------------------------- */}
        <Card title="Opportunities">
          {lead.opportunities.length === 0 ? (
            <EmptyState title="No opportunity yet" />
          ) : (
            <ul className="space-y-2">
              {lead.opportunities.map((opportunity) => (
                <li key={opportunity.id} className="rounded-lg border border-line-soft px-3 py-2.5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm text-white">{opportunity.name}</p>
                      <p className="text-xs text-white/40">
                        {humanise(opportunity.stage)} · {formatMoney(opportunity.monthly_value)}/mo
                        {opportunity.contract_months ? ` × ${opportunity.contract_months}mo` : ''}
                      </p>
                    </div>
                    <Badge tone={opportunity.stage === 'won' ? 'positive' : 'neutral'}>
                      {opportunity.probability === null ? '—' : `${opportunity.probability}%`}
                    </Badge>
                  </div>
                  {writable ? (
                    <div className="mt-2.5 space-y-2 border-t border-line-soft pt-2.5">
                      <Disclosure summary="Edit">
                        <OpportunityForm
                          action={saveOpportunity}
                          returnTo={here}
                          opportunity={opportunity}
                          leadId={lead.id}
                          people={people}
                          contacts={contactOptions}
                        />
                      </Disclosure>
                      <DeleteForm
                        action={removeOpportunity}
                        id={opportunity.id}
                        hidden={{ return_to: here }}
                        label="Delete opportunity"
                        warning="Deleting an opportunity also deletes its proposals. A lost deal is better recorded as lost than removed."
                        allowed={deletable}
                      />
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}

          <div className="mt-4 border-t border-line-soft pt-4">
            {writable ? (
              <Disclosure summary="Add an opportunity" tone="primary">
                <OpportunityForm
                  action={saveOpportunity}
                  returnTo={here}
                  leadId={lead.id}
                  people={people}
                  contacts={contactOptions}
                />
              </Disclosure>
            ) : (
              <ReadOnlyNotice what="create opportunities" />
            )}
          </div>
        </Card>

        <Card title="Tasks">
          {lead.tasks.length === 0 ? (
            <EmptyState title="No tasks" />
          ) : (
            <ul className="space-y-2">
              {lead.tasks.map((task) => (
                <li key={task.id} className="rounded-lg border border-line-soft px-3 py-2.5">
                  <div className="flex items-start justify-between gap-3">
                    <span className="min-w-0 flex-1 text-sm text-white/85">{task.title}</span>
                    <span className="whitespace-nowrap text-xs text-white/40">
                      {formatRelative(task.due_at)}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-white/35">
                    {humanise(task.status)} · {task.priority}
                  </p>
                  {writable ? (
                    <div className="mt-2.5 space-y-2 border-t border-line-soft pt-2.5">
                      <Disclosure summary="Edit">
                        <TaskForm
                          action={saveTask}
                          returnTo={here}
                          task={task}
                          leadId={lead.id}
                          people={people}
                        />
                      </Disclosure>
                      <DeleteForm
                        action={removeTask}
                        id={task.id}
                        hidden={{ return_to: here }}
                        label="Delete task"
                        warning="This task will be removed permanently."
                        allowed={deletable}
                      />
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}

          <div className="mt-4 border-t border-line-soft pt-4">
            {writable ? (
              <Disclosure summary="Add a task" tone="primary">
                <TaskForm action={saveTask} returnTo={here} leadId={lead.id} people={people} />
              </Disclosure>
            ) : (
              <ReadOnlyNotice what="create tasks" />
            )}
          </div>
        </Card>

        <Card title="Appointments">
          {lead.appointments.length === 0 ? (
            <EmptyState title="Nothing booked" />
          ) : (
            <ul className="space-y-2">
              {lead.appointments.map((appointment) => (
                <li key={appointment.id} className="rounded-lg border border-line-soft px-3 py-2.5">
                  <div className="flex items-start justify-between gap-3">
                    <span className="min-w-0 flex-1 text-sm text-white/85">{appointment.title}</span>
                    <Badge tone={appointment.status === 'confirmed' ? 'positive' : 'neutral'}>
                      {humanise(appointment.status)}
                    </Badge>
                  </div>
                  <p className="mt-1 text-xs text-white/40">
                    {formatDateTime(appointment.starts_at)} · {appointment.timezone}
                  </p>
                  {writable ? (
                    <div className="mt-2.5 space-y-2 border-t border-line-soft pt-2.5">
                      <Disclosure summary="Edit">
                        <AppointmentForm
                          action={saveAppointment}
                          returnTo={here}
                          appointment={appointment}
                          leadId={lead.id}
                          contacts={contactOptions}
                        />
                      </Disclosure>
                      <DeleteForm
                        action={removeAppointment}
                        id={appointment.id}
                        hidden={{ return_to: here }}
                        label="Delete appointment"
                        warning="Prefer setting the status to cancelled or no-show — a meeting that did not happen is a fact worth keeping."
                        allowed={deletable}
                      />
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}

          <div className="mt-4 border-t border-line-soft pt-4">
            {writable ? (
              <Disclosure summary="Book an appointment" tone="primary">
                <AppointmentForm
                  action={saveAppointment}
                  returnTo={here}
                  leadId={lead.id}
                  contacts={contactOptions}
                />
              </Disclosure>
            ) : (
              <ReadOnlyNotice what="book appointments" />
            )}
          </div>
        </Card>

        <Card title="Notes" description="Longer-form context that is not an activity.">
          {lead.notes.length === 0 ? (
            <EmptyState title="No notes" />
          ) : (
            <ul className="space-y-2">
              {lead.notes.map((note) => (
                <li key={note.id} className="rounded-lg border border-line-soft px-3 py-2.5">
                  {note.title ? (
                    <p className="text-sm font-medium text-white/85">{note.title}</p>
                  ) : null}
                  <p className="mt-1 whitespace-pre-wrap text-sm text-white/65">{noteText(note)}</p>
                  <p className="mt-1.5 text-xs text-white/30">{formatDateTime(note.created_at)}</p>
                  {writable ? (
                    <div className="mt-2.5 space-y-2 border-t border-line-soft pt-2.5">
                      <Disclosure summary="Edit">
                        <NoteForm
                          action={saveNote}
                          returnTo={here}
                          note={note}
                          leadId={lead.id}
                        />
                      </Disclosure>
                      <DeleteForm
                        action={removeNote}
                        id={note.id}
                        hidden={{ crm_lead_id: lead.id, return_to: here }}
                        label="Delete note"
                        warning="This note will be removed permanently."
                        allowed={deletable}
                      />
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}

          <div className="mt-4 border-t border-line-soft pt-4">
            {writable ? (
              <Disclosure summary="Add a note" tone="primary">
                <NoteForm action={saveNote} returnTo={here} leadId={lead.id} />
              </Disclosure>
            ) : (
              <ReadOnlyNotice what="add notes" />
            )}
          </div>
        </Card>

        {/* ---------------------------------------------------------------- */}
        {/* 4. Activity timeline                                              */}
        {/* ---------------------------------------------------------------- */}
        <Card
          title="Activity timeline"
          description="A record of what happened. Nothing on this page sends anything."
          className="xl:col-span-2"
        >
          {writable ? (
          <div className="grid grid-cols-1 gap-4 border-b border-line-soft pb-5 sm:grid-cols-2">
            <form action={addNote} className="space-y-2">
              <input type="hidden" name="lead_id" value={lead.id} />
              <span className="label-mono text-white/40">Add a note</span>
              <textarea name="body" rows={3} required className={inputClass} placeholder="What happened?" />
              <button
                type="submit"
                className="rounded-lg border border-line px-3 py-1.5 text-xs text-white/80 hover:border-electric-500/50"
              >
                Save note
              </button>
            </form>

            <form action={logCommunication} className="space-y-2">
              <input type="hidden" name="lead_id" value={lead.id} />
              <span className="label-mono text-white/40">Log a call or email</span>
              <div className="flex gap-2">
                <select name="type" className={inputClass} defaultValue="call">
                  <option value="call">Call</option>
                  <option value="email">Email</option>
                  <option value="meeting">Meeting</option>
                </select>
                <select name="direction" className={inputClass} defaultValue="outbound">
                  <option value="outbound">Outbound</option>
                  <option value="inbound">Inbound</option>
                </select>
              </div>
              <input type="text" name="outcome" placeholder="Outcome" className={inputClass} />
              <button
                type="submit"
                className="rounded-lg border border-line px-3 py-1.5 text-xs text-white/80 hover:border-electric-500/50"
              >
                Log it
              </button>
            </form>
          </div>
          ) : null}

          {lead.activities.length === 0 ? (
            <div className="pt-5">
              <EmptyState title="No activity yet" />
            </div>
          ) : (
            <ol className="mt-5 space-y-4">
              {lead.activities.map((activity) => (
                <li key={activity.id} className="flex gap-3">
                  <div className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-electric-500/60" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={activity.direction === 'inbound' ? 'positive' : 'neutral'}>
                        {humanise(activity.type)}
                      </Badge>
                      <span className="text-xs text-white/35">{activity.direction}</span>
                      <span className="text-xs text-white/30">
                        {formatDateTime(activity.occurred_at)}
                      </span>
                    </div>
                    {activity.subject ? (
                      <p className="mt-1 text-sm font-medium text-white/85">{activity.subject}</p>
                    ) : null}
                    {activity.body ? (
                      <p className="mt-1 whitespace-pre-wrap text-sm text-white/60">{activity.body}</p>
                    ) : null}
                    {activity.outcome ? (
                      <p className="mt-1 text-xs text-white/40">Outcome: {activity.outcome}</p>
                    ) : null}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </Card>

        {/* Stage history */}
        <Card title="Stage history" description="Written by a database trigger on every move.">
          {lead.stageHistory.length === 0 ? (
            <EmptyState title="No transitions recorded" />
          ) : (
            <Table head={['From', 'To', 'When']}>
              {lead.stageHistory.map((entry) => (
                <Row key={entry.id}>
                  <Cell className="text-white/45">
                    {entry.from_stage ? PIPELINE_STAGE_LABELS[entry.from_stage] : 'Created'}
                  </Cell>
                  <Cell>
                    <StageBadge stage={entry.to_stage} />
                  </Cell>
                  <Cell className="whitespace-nowrap text-white/40">
                    {formatRelative(entry.created_at)}
                  </Cell>
                </Row>
              ))}
            </Table>
          )}
        </Card>
      </div>

      <p className="mt-8 text-xs text-white/30">
        <Link href="/leads" className="hover:text-white/60">
          ← All leads
        </Link>
      </p>
    </>
  );
}

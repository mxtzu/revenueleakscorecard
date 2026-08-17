/**
 * Client detail — account state, contracts, payments and history.
 *
 * Payment status is displayed, never edited. Stripe is the source of truth for
 * whether money arrived; a CRM button that marks an invoice paid would let the
 * frontend assert a fact it cannot observe. When the Stripe webhook is built it
 * writes these rows with the service role, and this page keeps just reading
 * them.
 */

import Link from 'next/link';
import { notFound } from 'next/navigation';

import {
  Badge,
  Card,
  Cell,
  EmptyState,
  Field,
  FieldGrid,
  PageHeader,
  Row,
  Table
} from '@/components/crm/ui';
import {
  ClientForm,
  ContractForm,
  DocumentUploadForm,
  NoteForm,
  TaskForm
} from '@/components/crm/entityForms';
import {
  ActionError,
  ActionNotice,
  DeleteForm,
  Disclosure,
  ReadOnlyNotice
} from '@/components/crm/forms';
import {
  formatDate,
  formatDateTime,
  formatFileSize,
  formatMoney,
  humanise,
  orDash
} from '@/lib/crm/format';
import { noteText } from '@/lib/crm/mutations';
import { canWrite, isAdmin } from '@/lib/crm/permissions';
import {
  getClientById,
  listActivitiesForClient,
  listAssignableProfiles,
  listContractsForClient,
  listDocumentsForClient,
  listNotesForClient,
  listPaymentsForClient
} from '@/lib/crm/queries';
import { crmSession } from '@/lib/crm/server';
import type { ClientStatus } from '@/lib/crm/types';

import {
  InvoiceForm,
  InvoiceRow,
  SubscriptionForm,
  SubscriptionRow
} from '@/components/crm/billing';
import { isStripeConfigured } from '@/lib/billing/client';
import { listSubscriptionsForClient } from '@/lib/billing/queries';

import { removeClient, removeNote, saveClient, saveNote, saveTask } from '../../_actions/crud';
import {
  cancelInvoice,
  draftInvoice,
  emailInvoice,
  endSubscription,
  issueInvoice,
  keepSubscription,
  resyncBilling,
  startSubscription
} from '../../_actions/billing';
import {
  removeContract,
  removeDocument,
  saveContract,
  uploadDocument
} from '../../_actions/records';

export const dynamic = 'force-dynamic';

const CLIENT_TONE: Record<ClientStatus, 'neutral' | 'positive' | 'warning' | 'danger'> = {
  onboarding: 'warning',
  active: 'positive',
  paused: 'warning',
  cancelled: 'danger',
  churned: 'danger'
};

export default async function ClientDetailPage({
  params,
  searchParams
}: {
  params: { id: string };
  searchParams?: { error?: string; notice?: string };
}) {
  const { client: supabase, profile } = await crmSession();
  const account = await getClientById(supabase, params.id);
  if (!account) notFound();

  const [contracts, payments, activities, notes, documents, team, subscriptions] =
    await Promise.all([
    listContractsForClient(supabase, account.id),
    listPaymentsForClient(supabase, account.id),
    listActivitiesForClient(supabase, account.id),
    listNotesForClient(supabase, account.id),
    listDocumentsForClient(supabase, account.id),
    listAssignableProfiles(supabase),
    listSubscriptionsForClient(supabase, account.id)
  ]);

  const here = `/clients/${params.id}`;
  const writable = canWrite(profile);
  const deletable = isAdmin(profile);
  const people = team.map((member) => ({
    value: member.id,
    label: member.full_name ?? member.email ?? 'Unnamed'
  }));

  const collected = payments
    .filter((payment) => payment.status === 'paid')
    .reduce((total, payment) => total + Number(payment.amount), 0);
  const outstanding = payments
    .filter((payment) => payment.status === 'pending' || payment.status === 'overdue')
    .reduce((total, payment) => total + Number(payment.amount), 0);
  const currency = payments[0]?.currency ?? 'GBP';

  return (
    <>
      <PageHeader
        eyebrow="Client"
        title={account.company_name}
        actions={<Badge tone={CLIENT_TONE[account.status]}>{account.status}</Badge>}
      />

      <ActionError message={searchParams?.error} />
      <ActionNotice message={searchParams?.notice} />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card title="Account">
          <FieldGrid>
            <Field label="Status">{humanise(account.status)}</Field>
            <Field label="Start date">{formatDate(account.start_date)}</Field>
            <Field label="Renewal">{formatDate(account.renewal_date)}</Field>
            <Field label="Collected">{formatMoney(collected, currency)}</Field>
            <Field label="Outstanding">{formatMoney(outstanding, currency)}</Field>
            <Field label="Originating lead">
              {account.crm_lead_id ? (
                <Link href={`/leads/${account.crm_lead_id}`} className="text-electric-300 hover:underline">
                  View lead
                </Link>
              ) : (
                '—'
              )}
            </Field>
          </FieldGrid>

          <div className="mt-5 space-y-2 border-t border-line-soft pt-4">
            {writable ? (
              <>
                <Disclosure summary="Edit account">
                  <ClientForm
                    action={saveClient}
                    returnTo={here}
                    record={account}
                    people={people}
                  />
                </Disclosure>
                <DeleteForm
                  action={removeClient}
                  id={account.id}
                  label="Delete client"
                  warning="Contracts, payments, tasks and notes belonging to this client are deleted with it. A churned client is better recorded as churned."
                  allowed={deletable}
                />
              </>
            ) : (
              <ReadOnlyNotice what="edit this client" />
            )}
          </div>
        </Card>

        <Card title="Notes">
          {notes.length === 0 ? (
            <EmptyState title="No notes" />
          ) : (
            <ul className="space-y-2">
              {notes.map((note) => (
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
                          clientId={account.id}
                        />
                      </Disclosure>
                      <DeleteForm
                        action={removeNote}
                        id={note.id}
                        hidden={{ client_id: account.id, return_to: here }}
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
                <NoteForm action={saveNote} returnTo={here} clientId={account.id} />
              </Disclosure>
            ) : (
              <ReadOnlyNotice what="add notes" />
            )}
          </div>
        </Card>

        <Card title="Tasks">
          <div>
            {writable ? (
              <Disclosure summary="Add a task for this client" tone="primary">
                <TaskForm
                  action={saveTask}
                  returnTo={here}
                  clientId={account.id}
                  people={people}
                />
              </Disclosure>
            ) : (
              <ReadOnlyNotice what="create tasks" />
            )}
            <p className="mt-3 text-xs text-white/35">
              Open tasks for every account are listed together on{' '}
              <Link href="/tasks" className="text-electric-300 hover:underline">
                Tasks
              </Link>
              .
            </p>
          </div>
        </Card>

        <Card title="Contracts" className="xl:col-span-2">
          {contracts.length === 0 ? (
            <EmptyState title="No contracts recorded" />
          ) : (
            <Table head={['Status', 'Term', 'Monthly', 'Setup', 'Signed', '']}>
              {contracts.map((contract) => (
                <Row key={contract.id}>
                  <Cell>
                    <Badge tone={contract.status === 'active' ? 'positive' : 'neutral'}>
                      {humanise(contract.status)}
                    </Badge>
                  </Cell>
                  <Cell className="whitespace-nowrap text-white/55">
                    {formatDate(contract.start_date)} → {formatDate(contract.end_date)}
                  </Cell>
                  <Cell className="font-mono text-white/75">{formatMoney(contract.monthly_value)}</Cell>
                  <Cell className="font-mono text-white/75">{formatMoney(contract.setup_fee)}</Cell>
                  <Cell className="whitespace-nowrap text-white/45">
                    {formatDateTime(contract.signed_at)}
                  </Cell>
                  <Cell>
                    {writable ? (
                      <div className="flex min-w-[110px] flex-col items-start gap-1.5">
                        <Disclosure summary="Edit">
                          <div className="min-w-[320px] py-2">
                            <ContractForm
                              action={saveContract}
                              returnTo={here}
                              clientId={account.id}
                              contract={contract}
                            />
                          </div>
                        </Disclosure>
                        <DeleteForm
                          action={removeContract}
                          id={contract.id}
                          hidden={{ client_id: account.id, return_to: here }}
                          label="Delete"
                          warning="An expired or terminated contract is better recorded as such than removed."
                          allowed={deletable}
                        />
                      </div>
                    ) : null}
                  </Cell>
                </Row>
              ))}
            </Table>
          )}

          <div className="mt-4 border-t border-line-soft pt-4">
            {writable ? (
              <Disclosure summary="Add a contract" tone="primary">
                <ContractForm action={saveContract} returnTo={here} clientId={account.id} />
              </Disclosure>
            ) : (
              <ReadOnlyNotice what="add contracts" />
            )}
          </div>
        </Card>

        <Card title="Documents" description="Held in a private bucket; links expire after a minute.">
          {documents.length === 0 ? (
            <EmptyState title="No documents" />
          ) : (
            <ul className="space-y-2">
              {documents.map((document) => (
                <li
                  key={document.id}
                  className="rounded-lg border border-line-soft px-3 py-2.5"
                >
                  <a
                    href={`/api/crm/documents/${document.id}`}
                    className="text-sm text-electric-300 hover:underline"
                  >
                    {document.name}
                  </a>
                  <p className="mt-1 text-xs text-white/35">
                    {formatFileSize(document.file_size)} · {orDash(document.mime_type)} ·{' '}
                    {formatDateTime(document.created_at)}
                  </p>
                  {writable ? (
                    <div className="mt-2 border-t border-line-soft pt-2">
                      <DeleteForm
                        action={removeDocument}
                        id={document.id}
                        hidden={{ client_id: account.id, return_to: here }}
                        label="Delete file"
                        warning="The stored file is deleted too. This cannot be undone."
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
              <Disclosure summary="Upload a document" tone="primary">
                <DocumentUploadForm
                  action={uploadDocument}
                  returnTo={here}
                  clientId={account.id}
                />
              </Disclosure>
            ) : (
              <ReadOnlyNotice what="upload documents" />
            )}
          </div>
        </Card>

        <Card
          title="Billing"
          description="Invoices and retainers. Status comes from Stripe; nothing here can set it."
          className="xl:col-span-2"
        >
          {!isStripeConfigured() ? (
            <p className="mb-4 rounded-lg border border-line-soft bg-white/[0.02] px-3 py-2 text-xs text-white/45">
              Stripe is not configured on this deployment, so invoices cannot be raised from here.
            </p>
          ) : writable ? (
            <div className="mb-4 space-y-2">
              <Disclosure summary="Raise an invoice" tone="primary">
                <InvoiceForm
                  action={draftInvoice}
                  clientId={account.id}
                  returnTo={here}
                  defaultAmount={contracts[0]?.monthly_value ?? null}
                />
              </Disclosure>
              <Disclosure summary="Start a recurring retainer">
                <SubscriptionForm
                  action={startSubscription}
                  clientId={account.id}
                  returnTo={here}
                  defaultAmount={contracts[0]?.monthly_value ?? null}
                  contracts={contracts.map((contract) => ({
                    value: contract.id,
                    label: `${humanise(contract.status)} — ${formatMoney(contract.monthly_value, currency)}/mo`
                  }))}
                />
              </Disclosure>
              {account.stripe_customer_id ? (
                <form action={resyncBilling}>
                  <input type="hidden" name="client_id" value={account.id} />
                  <input type="hidden" name="return_to" value={here} />
                  {/* For history predating the webhook, and events missed while
                      a deployment was down. */}
                  <button
                    type="submit"
                    className="text-xs text-white/40 hover:text-white/70"
                  >
                    Re-read this client from Stripe
                  </button>
                </form>
              ) : null}
            </div>
          ) : (
            <ReadOnlyNotice what="raise invoices" />
          )}

          {subscriptions.length > 0 ? (
            <div className="mb-4">
              <p className="label-mono mb-2 text-white/35">Retainers</p>
              <Table head={['Client', 'What for', 'Amount', 'Status', 'Renews', '']}>
                {subscriptions.map((subscription) => (
                  <SubscriptionRow
                    key={subscription.id}
                    subscription={subscription}
                    clientName={account.company_name}
                    writable={writable}
                    returnTo={here}
                    onCancel={endSubscription}
                    onKeep={keepSubscription}
                  />
                ))}
              </Table>
            </div>
          ) : null}

          {payments.length === 0 ? (
            <EmptyState title="No invoices yet" />
          ) : (
            <Table head={['Invoice', 'Client', 'Amount', 'Status', 'Due', 'Paid', '']}>
              {payments.map((payment) => (
                <InvoiceRow
                  key={payment.id}
                  payment={payment}
                  clientName={account.company_name}
                  writable={writable}
                  returnTo={here}
                  onIssue={issueInvoice}
                  onEmail={emailInvoice}
                  onVoid={cancelInvoice}
                />
              ))}
            </Table>
          )}
        </Card>

        <Card title="Activity">
          {activities.length === 0 ? (
            <EmptyState title="No activity recorded" />
          ) : (
            <ol className="space-y-3">
              {activities.map((activity) => (
                <li key={activity.id} className="border-b border-line-soft/60 pb-2 last:border-0">
                  <div className="flex items-center gap-2">
                    <Badge>{humanise(activity.type)}</Badge>
                    <span className="text-xs text-white/30">
                      {formatDateTime(activity.occurred_at)}
                    </span>
                  </div>
                  {activity.subject ? (
                    <p className="mt-1 text-sm text-white/80">{activity.subject}</p>
                  ) : null}
                  {activity.body ? (
                    <p className="mt-1 whitespace-pre-wrap text-xs text-white/50">{activity.body}</p>
                  ) : null}
                </li>
              ))}
            </ol>
          )}
        </Card>
      </div>

      <p className="mt-8 text-xs text-white/30">
        <Link href="/clients" className="hover:text-white/60">
          ← All clients
        </Link>
      </p>
    </>
  );
}

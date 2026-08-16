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
import { formatDate, formatDateTime, formatMoney, humanise, orDash } from '@/lib/crm/format';
import {
  getClientById,
  listActivitiesForClient,
  listContractsForClient,
  listPaymentsForClient
} from '@/lib/crm/queries';
import { crmClient } from '@/lib/crm/server';
import type { ClientStatus, PaymentStatus } from '@/lib/crm/types';

export const dynamic = 'force-dynamic';

const CLIENT_TONE: Record<ClientStatus, 'neutral' | 'positive' | 'warning' | 'danger'> = {
  onboarding: 'warning',
  active: 'positive',
  paused: 'warning',
  cancelled: 'danger',
  churned: 'danger'
};

const PAYMENT_TONE: Record<PaymentStatus, 'neutral' | 'positive' | 'warning' | 'danger'> = {
  pending: 'neutral',
  paid: 'positive',
  failed: 'danger',
  overdue: 'danger',
  refunded: 'warning',
  cancelled: 'neutral'
};

export default async function ClientDetailPage({ params }: { params: { id: string } }) {
  const supabase = crmClient();
  const account = await getClientById(supabase, params.id);
  if (!account) notFound();

  const [contracts, payments, activities] = await Promise.all([
    listContractsForClient(supabase, account.id),
    listPaymentsForClient(supabase, account.id),
    listActivitiesForClient(supabase, account.id)
  ]);

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
        </Card>

        <Card title="Contracts" className="xl:col-span-2">
          {contracts.length === 0 ? (
            <EmptyState title="No contracts recorded" />
          ) : (
            <Table head={['Status', 'Term', 'Monthly', 'Setup', 'Signed']}>
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
                </Row>
              ))}
            </Table>
          )}
        </Card>

        <Card
          title="Payments"
          description="Read-only. Stripe decides what is paid; the CRM records it."
          className="xl:col-span-2"
        >
          {payments.length === 0 ? (
            <EmptyState title="No payments recorded" />
          ) : (
            <Table head={['Amount', 'Status', 'Due', 'Paid', 'Stripe invoice']}>
              {payments.map((payment) => (
                <Row key={payment.id}>
                  <Cell className="font-mono text-white/85">
                    {formatMoney(payment.amount, payment.currency)}
                  </Cell>
                  <Cell>
                    <Badge tone={PAYMENT_TONE[payment.status]}>{humanise(payment.status)}</Badge>
                  </Cell>
                  <Cell className="whitespace-nowrap text-white/50">{formatDate(payment.due_at)}</Cell>
                  <Cell className="whitespace-nowrap text-white/50">
                    {formatDateTime(payment.paid_at)}
                  </Cell>
                  <Cell className="font-mono text-xs text-white/30">
                    {orDash(payment.stripe_invoice_id)}
                  </Cell>
                </Row>
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

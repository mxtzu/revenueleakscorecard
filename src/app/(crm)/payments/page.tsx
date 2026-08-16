/**
 * Payments — every invoice the CRM knows about.
 *
 * Entirely read-only, and that is a security property, not a missing feature.
 * `payments` has a SELECT policy and no INSERT/UPDATE policy, so even a
 * hand-crafted request from a signed-in user cannot mark an invoice paid. The
 * only writer will be the Stripe webhook, running server-side with the service
 * role, reacting to events Stripe signed.
 */

import Link from 'next/link';

import { Badge, Card, Cell, EmptyState, PageHeader, Row, StatCard, Table } from '@/components/crm/ui';
import { formatDate, formatDateTime, formatMoney, humanise, orDash } from '@/lib/crm/format';
import { listPayments } from '@/lib/crm/queries';
import { crmClient } from '@/lib/crm/server';
import type { PaymentStatus } from '@/lib/crm/types';

export const dynamic = 'force-dynamic';

const TONE: Record<PaymentStatus, 'neutral' | 'positive' | 'warning' | 'danger'> = {
  pending: 'neutral',
  paid: 'positive',
  failed: 'danger',
  overdue: 'danger',
  refunded: 'warning',
  cancelled: 'neutral'
};

export default async function PaymentsPage() {
  const payments = await listPayments(crmClient(), 300);
  const currency = payments[0]?.currency ?? 'GBP';

  const sum = (status: PaymentStatus[]) =>
    payments
      .filter((payment) => status.includes(payment.status))
      .reduce((total, payment) => total + Number(payment.amount), 0);

  return (
    <>
      <PageHeader
        eyebrow="Finance"
        title="Payments"
        description="Invoice records. Status is set by Stripe, never from this screen."
      />

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Collected" value={formatMoney(sum(['paid']), currency)} />
        <StatCard label="Pending" value={formatMoney(sum(['pending']), currency)} />
        <StatCard label="Overdue" value={formatMoney(sum(['overdue']), currency)} />
        <StatCard label="Failed" value={formatMoney(sum(['failed']), currency)} />
      </div>

      <Card title={`${payments.length} payment${payments.length === 1 ? '' : 's'}`}>
        {payments.length === 0 ? (
          <EmptyState
            title="No payments recorded"
            description="Stripe processing is not part of this build. Rows appear here once the webhook is connected."
          />
        ) : (
          <Table head={['Amount', 'Status', 'Client', 'Due', 'Paid', 'Stripe invoice']}>
            {payments.map((payment) => (
              <Row key={payment.id}>
                <Cell className="font-mono text-white/85">
                  {formatMoney(payment.amount, payment.currency)}
                </Cell>
                <Cell>
                  <Badge tone={TONE[payment.status]}>{humanise(payment.status)}</Badge>
                </Cell>
                <Cell>
                  {payment.client_id ? (
                    <Link
                      href={`/clients/${payment.client_id}`}
                      className="text-electric-300 hover:underline"
                    >
                      View client
                    </Link>
                  ) : (
                    <span className="text-white/30">—</span>
                  )}
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
    </>
  );
}

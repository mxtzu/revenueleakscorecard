/**
 * Payments — the money dashboard.
 *
 * Invoices and subscriptions, with totals that are worth quoting: collected is
 * net of refunds, outstanding includes overdue, and MRR normalises every
 * billing interval to a month.
 *
 * The status column is read-only, and that is a security property rather than
 * a missing feature. `payments` and `subscriptions` have a SELECT policy and
 * no INSERT or UPDATE policy, so nothing a browser can send marks an invoice
 * paid. The only writer is the Stripe webhook, running server-side with the
 * service role, reacting to events Stripe signed. The controls on this page
 * ask Stripe to do something; they never assert an outcome.
 */

import {
  BillingModeNotice,
  InvoiceRow,
  SubscriptionRow
} from '@/components/crm/billing';
import { ActionError, ActionNotice } from '@/components/crm/forms';
import { Card, EmptyState, PageHeader, StatCard, Table } from '@/components/crm/ui';
import { isLiveMode, isStripeConfigured, isWebhookConfigured } from '@/lib/billing/client';
import { billingTotals, listSubscriptions } from '@/lib/billing/queries';
import { formatMoney } from '@/lib/crm/format';
import { canWrite } from '@/lib/crm/permissions';
import { listClients, listPayments } from '@/lib/crm/queries';
import { crmSession } from '@/lib/crm/server';

import { cancelInvoice, emailInvoice, endSubscription, issueInvoice, keepSubscription } from '../_actions/billing';

export const dynamic = 'force-dynamic';

export default async function PaymentsPage({
  searchParams
}: {
  searchParams?: { error?: string; notice?: string };
}) {
  const { client, profile } = await crmSession();
  const [payments, subscriptions, clients] = await Promise.all([
    listPayments(client, 300),
    listSubscriptions(client, 200),
    listClients(client)
  ]);

  const writable = canWrite(profile);
  const totals = billingTotals(payments, subscriptions);
  const nameOf = new Map(clients.map((account) => [account.id, account.company_name]));

  const live = subscriptions.filter((subscription) =>
    ['active', 'trialing', 'past_due'].includes(subscription.status)
  );

  return (
    <>
      <PageHeader
        eyebrow="Finance"
        title="Payments"
        description="Invoices and retainers. Status comes from Stripe and cannot be set here."
      />

      <ActionError message={searchParams?.error} />
      <ActionNotice message={searchParams?.notice} />

      <BillingModeNotice
        configured={isStripeConfigured()}
        webhookConfigured={isWebhookConfigured()}
        liveMode={isLiveMode()}
      />

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="MRR"
          value={formatMoney(totals.mrr, totals.currency)}
          hint={`${live.length} live retainer${live.length === 1 ? '' : 's'}`}
        />
        <StatCard
          label="Collected this month"
          value={formatMoney(totals.collectedThisMonth, totals.currency)}
          hint="Net of refunds"
        />
        <StatCard
          label="Outstanding"
          value={formatMoney(totals.outstanding, totals.currency)}
          hint="Issued and unpaid"
        />
        <StatCard
          label="Overdue"
          value={formatMoney(totals.overdue, totals.currency)}
          hint="Past the due date"
        />
      </div>

      <Card
        title={`${subscriptions.length} retainer${subscriptions.length === 1 ? '' : 's'}`}
        className="mb-4"
      >
        {subscriptions.length === 0 ? (
          <EmptyState
            title="No retainers"
            description="Start one from a client's page once the deal is signed."
          />
        ) : (
          <Table head={['Client', 'What for', 'Amount', 'Status', 'Renews', '']}>
            {subscriptions.map((subscription) => (
              <SubscriptionRow
                key={subscription.id}
                subscription={subscription}
                clientName={subscription.client_id ? nameOf.get(subscription.client_id) : null}
                writable={writable}
                returnTo="/payments"
                onCancel={endSubscription}
                onKeep={keepSubscription}
              />
            ))}
          </Table>
        )}
      </Card>

      <Card title={`${payments.length} invoice${payments.length === 1 ? '' : 's'}`}>
        {payments.length === 0 ? (
          <EmptyState
            title="No invoices"
            description={
              isStripeConfigured()
                ? 'Raise one from a client’s page. Invoices created in Stripe directly appear here too, once the webhook delivers them.'
                : 'Stripe is not configured on this deployment.'
            }
          />
        ) : (
          <Table head={['Invoice', 'Client', 'Amount', 'Status', 'Due', 'Paid', '']}>
            {payments.map((payment) => (
              <InvoiceRow
                key={payment.id}
                payment={payment}
                clientName={payment.client_id ? nameOf.get(payment.client_id) : null}
                writable={writable}
                returnTo="/payments"
                onIssue={issueInvoice}
                onEmail={emailInvoice}
                onVoid={cancelInvoice}
              />
            ))}
          </Table>
        )}

        <p className="mt-4 border-t border-line-soft pt-3 text-xs leading-relaxed text-white/35">
          Nothing on this page can mark an invoice paid. The database has no write policy on{' '}
          <span className="font-mono">payments</span> for any role — status arrives from Stripe by
          webhook. An invoice stuck on pending after a client has paid means the webhook is not
          being delivered, not that the control is missing — check the webhook log in the Stripe
          dashboard.
        </p>
      </Card>
    </>
  );
}

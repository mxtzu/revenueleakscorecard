/**
 * Billing UI.
 *
 * One thing worth saying at the top of every screen here: the status column is
 * not editable, and that is a security property rather than a missing feature.
 * `payments` has no write policy, so nothing a browser can send marks an
 * invoice paid — only the Stripe webhook does. The copy says so, because a
 * read-only table with no explanation reads as unfinished.
 */

import { Badge, Card, Cell, Row } from './ui';
import { CheckboxField, FormGrid, ReturnTo, SelectField, SubmitButton, TextField } from './forms';
import { formatDate, formatMoney, humanise } from '@/lib/crm/format';
import type { SubscriptionRecord } from '@/lib/billing/queries';
import type { Payment, PaymentStatus } from '@/lib/crm/types';

type Action = (formData: FormData) => void | Promise<void>;

export const PAYMENT_TONE: Record<
  PaymentStatus,
  'neutral' | 'positive' | 'warning' | 'danger'
> = {
  pending: 'neutral',
  paid: 'positive',
  failed: 'danger',
  overdue: 'danger',
  refunded: 'warning',
  cancelled: 'neutral'
};

const SUBSCRIPTION_TONE: Record<string, 'neutral' | 'positive' | 'warning' | 'danger'> = {
  active: 'positive',
  trialing: 'info' as 'positive',
  past_due: 'danger',
  unpaid: 'danger',
  canceled: 'neutral',
  incomplete: 'warning',
  incomplete_expired: 'neutral',
  paused: 'warning'
};

/** How this deployment is configured, said plainly rather than implied. */
export function BillingModeNotice({
  configured,
  webhookConfigured,
  liveMode
}: {
  configured: boolean;
  webhookConfigured: boolean;
  liveMode: boolean;
}) {
  if (!configured) {
    return (
      <Card title="Stripe" className="mb-4">
        <p className="text-sm text-white/55">
          Not configured on this deployment. Invoices and subscriptions cannot be raised, and the
          table below stays empty.
        </p>
        <p className="mt-2 text-xs text-white/35">
          Set STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET. See docs/agency-crm.md.
        </p>
      </Card>
    );
  }

  return (
    <div className="mb-4 flex flex-wrap items-center gap-2 text-xs">
      <Badge tone={liveMode ? 'positive' : 'warning'}>
        {liveMode ? 'Stripe live mode' : 'Stripe test mode'}
      </Badge>
      {webhookConfigured ? (
        <span className="text-white/35">Webhook configured — status updates arrive from Stripe.</span>
      ) : (
        <span className="text-amber-300/80">
          STRIPE_WEBHOOK_SECRET is not set: nothing will ever move to paid on its own.
        </span>
      )}
    </div>
  );
}

/** One invoice row, with the controls its current status allows. */
export function InvoiceRow({
  payment,
  clientName,
  writable,
  returnTo,
  onIssue,
  onEmail,
  onVoid
}: {
  payment: Payment;
  clientName?: string | null;
  writable: boolean;
  returnTo: string;
  onIssue: Action;
  onEmail: Action;
  onVoid: Action;
}) {
  const isDraft = payment.stripe_status === 'draft';
  const isOpen = payment.stripe_status === 'open';
  const settled = payment.status === 'paid' || payment.status === 'refunded';

  return (
    <Row>
      <Cell className="font-mono text-xs text-white/40">
        {payment.invoice_number ?? payment.stripe_invoice_id ?? '—'}
      </Cell>
      <Cell className="text-white/70">{clientName ?? '—'}</Cell>
      <Cell className="font-mono text-white/85">
        {formatMoney(payment.amount, payment.currency)}
        {payment.amount_refunded > 0 ? (
          <span className="block text-xs text-amber-300/70">
            −{formatMoney(payment.amount_refunded, payment.currency)} refunded
          </span>
        ) : null}
      </Cell>
      <Cell>
        <Badge tone={PAYMENT_TONE[payment.status]}>{humanise(payment.status)}</Badge>
        {payment.stripe_status && payment.stripe_status !== payment.status ? (
          <span className="ml-1.5 text-[11px] text-white/30">({payment.stripe_status})</span>
        ) : null}
      </Cell>
      <Cell className="whitespace-nowrap text-white/45">{formatDate(payment.due_at)}</Cell>
      <Cell className="whitespace-nowrap text-white/45">{formatDate(payment.paid_at)}</Cell>
      <Cell>
        <div className="flex flex-wrap items-center gap-2">
          {payment.hosted_invoice_url ? (
            <a
              href={payment.hosted_invoice_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-electric-300 hover:underline"
            >
              Payment page
            </a>
          ) : null}
          {payment.invoice_pdf_url ? (
            <a
              href={payment.invoice_pdf_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-white/40 hover:text-white/70"
            >
              PDF
            </a>
          ) : null}

          {writable && payment.stripe_invoice_id && !settled ? (
            <>
              {isDraft ? (
                <form action={onIssue}>
                  <input type="hidden" name="stripe_invoice_id" value={payment.stripe_invoice_id} />
                  <input type="hidden" name="client_id" value={payment.client_id ?? ''} />
                  <ReturnTo path={returnTo} />
                  <button
                    type="submit"
                    className="rounded-lg border border-line px-2 py-0.5 text-[11px] text-white/60 hover:border-electric-500/50 hover:text-white/90"
                  >
                    Finalise
                  </button>
                </form>
              ) : null}

              {isDraft || isOpen ? (
                <form action={onEmail}>
                  <input type="hidden" name="stripe_invoice_id" value={payment.stripe_invoice_id} />
                  <input type="hidden" name="client_id" value={payment.client_id ?? ''} />
                  <ReturnTo path={returnTo} />
                  {/* The only control in the CRM that emails a client. */}
                  <button
                    type="submit"
                    className="rounded-lg border border-electric-500/40 px-2 py-0.5 text-[11px] text-electric-300 hover:bg-electric-500/10"
                  >
                    Email it
                  </button>
                </form>
              ) : null}

              <form action={onVoid}>
                <input type="hidden" name="stripe_invoice_id" value={payment.stripe_invoice_id} />
                <input type="hidden" name="client_id" value={payment.client_id ?? ''} />
                <ReturnTo path={returnTo} />
                <button
                  type="submit"
                  className="rounded-lg border border-rose-400/30 px-2 py-0.5 text-[11px] text-rose-200/80 hover:bg-rose-400/10"
                >
                  Void
                </button>
              </form>
            </>
          ) : null}
        </div>
      </Cell>
    </Row>
  );
}

export function SubscriptionRow({
  subscription,
  clientName,
  writable,
  returnTo,
  onCancel,
  onKeep
}: {
  subscription: SubscriptionRecord;
  clientName?: string | null;
  writable: boolean;
  returnTo: string;
  onCancel: Action;
  onKeep: Action;
}) {
  const live = ['active', 'trialing', 'past_due'].includes(subscription.status);
  const every =
    subscription.interval_count && subscription.interval_count > 1
      ? `every ${subscription.interval_count} ${subscription.interval}s`
      : `per ${subscription.interval ?? 'period'}`;

  return (
    <Row>
      <Cell className="text-white/70">{clientName ?? '—'}</Cell>
      <Cell className="text-white/85">
        {subscription.description ?? 'Retainer'}
        <span className="block font-mono text-[11px] text-white/25">
          {subscription.stripe_subscription_id}
        </span>
      </Cell>
      <Cell className="font-mono text-white/85">
        {formatMoney(subscription.amount, subscription.currency)}
        <span className="block text-[11px] text-white/35">{every}</span>
      </Cell>
      <Cell>
        <Badge tone={SUBSCRIPTION_TONE[subscription.status] ?? 'neutral'}>
          {humanise(subscription.status)}
        </Badge>
        {subscription.cancel_at_period_end ? (
          <span className="mt-1 block text-[11px] text-amber-300/70">Ends at period close</span>
        ) : null}
      </Cell>
      <Cell className="whitespace-nowrap text-white/45">
        {formatDate(subscription.current_period_end)}
      </Cell>
      <Cell>
        {writable && live ? (
          subscription.cancel_at_period_end ? (
            <form action={onKeep}>
              <input
                type="hidden"
                name="stripe_subscription_id"
                value={subscription.stripe_subscription_id}
              />
              <input type="hidden" name="client_id" value={subscription.client_id ?? ''} />
              <ReturnTo path={returnTo} />
              <button
                type="submit"
                className="rounded-lg border border-line px-2 py-0.5 text-[11px] text-white/60 hover:border-electric-500/50 hover:text-white/90"
              >
                Keep it running
              </button>
            </form>
          ) : (
            <form action={onCancel}>
              <input
                type="hidden"
                name="stripe_subscription_id"
                value={subscription.stripe_subscription_id}
              />
              <input type="hidden" name="client_id" value={subscription.client_id ?? ''} />
              <ReturnTo path={returnTo} />
              {/* Ends at the period boundary. Immediate cancellation would take
                  away service the client has already paid for. */}
              <button
                type="submit"
                className="rounded-lg border border-rose-400/30 px-2 py-0.5 text-[11px] text-rose-200/80 hover:bg-rose-400/10"
              >
                Cancel at period end
              </button>
            </form>
          )
        ) : null}
      </Cell>
    </Row>
  );
}

// ---------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------
export function InvoiceForm({
  action,
  clientId,
  returnTo,
  defaultAmount
}: {
  action: Action;
  clientId: string;
  returnTo: string;
  defaultAmount?: number | null;
}) {
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="client_id" value={clientId} />
      <ReturnTo path={returnTo} />

      <TextField
        name="description"
        label="What for"
        required
        placeholder="Google Ads management — September"
      />

      <FormGrid>
        <TextField
          name="amount"
          label="Amount"
          type="number"
          hint="(£)"
          defaultValue={defaultAmount?.toString()}
        />
        <TextField name="quantity" label="Quantity" type="number" defaultValue="1" />
        <TextField
          name="days_until_due"
          label="Payment terms"
          type="number"
          hint="(days)"
          defaultValue="14"
        />
      </FormGrid>

      <TextField name="note" label="Note on the invoice" placeholder="Thanks for your business" />

      <div className="space-y-1 rounded-lg border border-line-soft p-3">
        <CheckboxField
          name="finalize"
          label="Finalise it"
          hint="Gives it an invoice number and a payment link. Still does not email anyone."
        />
        <CheckboxField
          name="send"
          label="Email it to the client now"
          hint="Stripe sends the invoice. This is the only control in the CRM that contacts a client."
        />
      </div>

      <SubmitButton>Create the invoice</SubmitButton>
    </form>
  );
}

export function SubscriptionForm({
  action,
  clientId,
  returnTo,
  defaultAmount,
  contracts = []
}: {
  action: Action;
  clientId: string;
  returnTo: string;
  defaultAmount?: number | null;
  contracts?: { value: string; label: string }[];
}) {
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="client_id" value={clientId} />
      <ReturnTo path={returnTo} />

      <TextField
        name="description"
        label="What the retainer covers"
        placeholder="Google Ads management"
      />

      <FormGrid>
        <TextField
          name="amount"
          label="Amount"
          type="number"
          hint="(£ per cycle)"
          defaultValue={defaultAmount?.toString()}
        />
        <SelectField
          name="interval"
          label="Billed"
          options={[
            { value: 'month', label: 'Monthly' },
            { value: 'year', label: 'Yearly' },
            { value: 'week', label: 'Weekly' },
            { value: 'day', label: 'Daily' }
          ]}
          defaultValue="month"
        />
        <TextField name="interval_count" label="Every" type="number" defaultValue="1" hint="(cycles)" />
        <TextField name="trial_days" label="Free period" type="number" hint="(days)" />
        {contracts.length > 0 ? (
          <SelectField
            name="contract_id"
            label="Contract"
            options={contracts}
            placeholder="Not linked"
          />
        ) : null}
      </FormGrid>

      <p className="rounded-lg border border-line-soft bg-white/[0.02] px-3 py-2 text-xs leading-relaxed text-white/45">
        Stripe raises and emails an invoice on every cycle from now on. Cancelling later stops at
        the end of the paid period, so the client keeps what they have paid for.
      </p>

      <SubmitButton>Start the retainer</SubmitButton>
    </form>
  );
}

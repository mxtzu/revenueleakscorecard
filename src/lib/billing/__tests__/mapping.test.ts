import { describe, expect, it } from 'vitest';

import { invoiceToPayment, paymentStatusFor, shouldApply, subscriptionToRow } from '../mapping';
import { at, stripeInvoice, stripeSubscription } from './fakes';

const NOW = new Date('2026-09-21T12:00:00Z');

describe('invoice status', () => {
  it('reads each Stripe status the way an accountant would', () => {
    const cases: [string, string][] = [
      ['draft', 'pending'],
      ['open', 'pending'],
      ['paid', 'paid'],
      ['void', 'cancelled'],
      ['uncollectible', 'failed']
    ];
    for (const [stripeStatus, expected] of cases) {
      expect(
        paymentStatusFor(
          { status: stripeStatus as never, due_date: null },
          { amountPaid: 0, amountRefunded: 0 },
          NOW
        )
      ).toBe(expected);
    }
  });

  it('calls an open invoice overdue once its due date passes', () => {
    const past = Math.floor(new Date('2026-09-01T00:00:00Z').getTime() / 1000);
    const future = Math.floor(new Date('2026-10-01T00:00:00Z').getTime() / 1000);
    expect(
      paymentStatusFor({ status: 'open', due_date: past }, { amountPaid: 0, amountRefunded: 0 }, NOW)
    ).toBe('overdue');
    expect(
      paymentStatusFor({ status: 'open', due_date: future }, { amountPaid: 0, amountRefunded: 0 }, NOW)
    ).toBe('pending');
  });

  /**
   * A refunded invoice is still `paid` at Stripe. Reading only the status
   * would keep counting money that went back to the client as collected.
   */
  it('shows a refund even though Stripe still says paid', () => {
    expect(
      paymentStatusFor(
        { status: 'paid', due_date: null },
        { amountPaid: 1500, amountRefunded: 1500 },
        NOW
      )
    ).toBe('refunded');
    expect(
      paymentStatusFor(
        { status: 'paid', due_date: null },
        { amountPaid: 1500, amountRefunded: 250 },
        NOW
      )
    ).toBe('refunded');
  });
});

describe('invoice to payment row', () => {
  it('converts money out of minor units', () => {
    const row = invoiceToPayment(stripeInvoice());
    expect(row.amount).toBe(1500);
    expect(row.amount_due).toBe(1500);
    expect(row.currency).toBe('gbp');
  });

  /**
   * `amount_due` drops to zero once an invoice is paid. Storing that as the
   * amount would make every settled invoice show as £0.
   */
  it('records the total, not the outstanding balance', () => {
    const row = invoiceToPayment(
      stripeInvoice({ status: 'paid', amount_due: 0, amount_paid: 150000, total: 150000 })
    );
    expect(row.amount).toBe(1500);
    expect(row.amount_paid).toBe(1500);
    expect(row.status).toBe('paid');
  });

  it('takes the settled time from Stripe, not from the clock', () => {
    // A retried webhook is processed days later; `now` would record the retry.
    const row = invoiceToPayment(
      stripeInvoice({
        status: 'paid',
        status_transitions: { paid_at: at('2026-09-15T10:30:00Z'), voided_at: null }
      })
    );
    expect(row.paid_at).toBe('2026-09-15T10:30:00.000Z');
  });

  it('keeps Stripe’s own status alongside the CRM reading', () => {
    const row = invoiceToPayment(stripeInvoice({ status: 'uncollectible' }));
    expect(row.stripe_status).toBe('uncollectible');
    expect(row.status).toBe('failed');
  });

  it('unwraps ids whether Stripe expanded them or not', () => {
    const asString = invoiceToPayment(stripeInvoice({ customer: 'cus_plain' }));
    const asObject = invoiceToPayment(
      stripeInvoice({ customer: { id: 'cus_expanded', object: 'customer' } })
    );
    expect(asString.stripe_customer_id).toBe('cus_plain');
    expect(asObject.stripe_customer_id).toBe('cus_expanded');
  });

  it('carries the hosted payment link Stripe minted', () => {
    // Never constructed here — a guessed invoice URL is a broken one.
    const row = invoiceToPayment(stripeInvoice());
    expect(row.hosted_invoice_url).toBe('https://invoice.stripe.com/i/test');
    expect(row.invoice_pdf_url).toBe('https://invoice.stripe.com/i/test.pdf');
  });
});

describe('subscription to row', () => {
  it('reads the amount, interval and period', () => {
    const row = subscriptionToRow(stripeSubscription());
    expect(row.amount).toBe(1500);
    expect(row.interval).toBe('month');
    expect(row.status).toBe('active');
    expect(row.current_period_end).toBe('2026-10-01T00:00:00.000Z');
  });

  it('sums every item, not just the first', () => {
    const row = subscriptionToRow(
      stripeSubscription({
        items: {
          object: 'list',
          data: [
            { id: 'si_1', quantity: 1, price: { id: 'p1', currency: 'gbp', unit_amount: 150000 } },
            { id: 'si_2', quantity: 2, price: { id: 'p2', currency: 'gbp', unit_amount: 25000 } }
          ]
        }
      })
    );
    expect(row.amount).toBe(2000);
  });

  it('does not invent an amount for a subscription with no items', () => {
    const row = subscriptionToRow(
      stripeSubscription({ items: { object: 'list', data: [] } })
    );
    expect(row.amount).toBeNull();
  });

  /**
   * A status this build has never seen must not be counted as revenue. `unpaid`
   * surfaces it as needing attention instead.
   */
  it('treats an unrecognised status as needing attention', () => {
    const row = subscriptionToRow(stripeSubscription({ status: 'some_new_status' }));
    expect(row.status).toBe('unpaid');
  });

  it('records a pending cancellation', () => {
    const row = subscriptionToRow(stripeSubscription({ cancel_at_period_end: true }));
    expect(row.cancel_at_period_end).toBe(true);
    expect(row.status).toBe('active');
  });
});

/**
 * Stripe does not guarantee order. `invoice.paid` arriving before
 * `invoice.finalized` is normal, and applying the older one second would show
 * an unpaid invoice for money already in the bank.
 */
describe('late deliveries', () => {
  it('applies a newer event and skips an older one', () => {
    expect(shouldApply('2026-09-21T12:00:00Z', '2026-09-21T11:00:00Z')).toBe(true);
    expect(shouldApply('2026-09-21T10:00:00Z', '2026-09-21T11:00:00Z')).toBe(false);
  });

  it('applies an event with the same timestamp', () => {
    // Two events can share a second; skipping them would lose real updates.
    const same = '2026-09-21T12:00:00Z';
    expect(shouldApply(same, same)).toBe(true);
  });

  it('applies anything when nothing has been recorded yet', () => {
    expect(shouldApply('2026-09-21T12:00:00Z', null)).toBe(true);
    expect(shouldApply(null, '2026-09-21T12:00:00Z')).toBe(true);
  });
});

import Stripe from 'stripe';
import { describe, expect, it } from 'vitest';

import { applyEvent, claimEvent, recordInvoice, recordRefund } from '../events';
import {
  at,
  CLIENT_ID,
  CUSTOMER_ID,
  crmClientRow,
  FakeDb,
  signedEvent,
  stripeEvent,
  stripeInvoice,
  stripeSubscription
} from './fakes';

function db(extra: Record<string, Record<string, unknown>[]> = {}) {
  return new FakeDb({ clients: [crmClientRow()], payments: [], subscriptions: [], stripe_events: [], ...extra });
}

describe('recording an invoice', () => {
  it('attributes it to the client behind the Stripe customer', async () => {
    const store = db();
    await recordInvoice(store.client(), stripeInvoice());

    const payment = store.first('payments')!;
    expect(payment.client_id).toBe(CLIENT_ID);
    expect(payment.stripe_invoice_id).toBe('in_test123');
    expect(payment.amount).toBe(1500);
    expect(payment.status).toBe('pending');
  });

  /**
   * Money that exists but is invisible is worse than money that is
   * unattributed — an invoice raised in the Stripe dashboard for someone who is
   * not a CRM client still has to appear.
   */
  it('records an invoice for a customer the CRM does not know', async () => {
    const store = db();
    await recordInvoice(store.client(), stripeInvoice({ customer: 'cus_stranger' }));

    const payment = store.first('payments')!;
    expect(payment.client_id).toBeNull();
    expect(payment.amount).toBe(1500);
  });

  it('updates in place rather than making a second row', async () => {
    const store = db();
    await recordInvoice(store.client(), stripeInvoice(), { eventAt: '2026-09-21T10:00:00Z' });
    await recordInvoice(
      store.client(),
      stripeInvoice({ status: 'paid', amount_paid: 150000, status_transitions: { paid_at: at('2026-09-22T09:00:00Z') } }),
      { eventAt: '2026-09-22T09:00:00Z' }
    );

    expect(store.rows('payments')).toHaveLength(1);
    expect(store.first('payments')!.status).toBe('paid');
  });

  /**
   * The failure this exists to prevent: `invoice.paid` arrives, then a delayed
   * `invoice.finalized` from an earlier moment. Applying the second would show
   * an unpaid invoice for money already banked.
   */
  it('ignores an event older than the one already applied', async () => {
    const store = db();
    await recordInvoice(
      store.client(),
      stripeInvoice({ status: 'paid', amount_paid: 150000 }),
      { eventAt: '2026-09-22T09:00:00Z' }
    );

    const result = await recordInvoice(store.client(), stripeInvoice({ status: 'open' }), {
      eventAt: '2026-09-21T10:00:00Z'
    });

    expect(result.applied).toBe(false);
    expect(store.first('payments')!.status).toBe('paid');
  });

  it('links the invoice to a subscription row when one exists', async () => {
    const store = db({
      subscriptions: [{ id: 'sub-row-1', stripe_subscription_id: 'sub_test123' }]
    });
    await recordInvoice(store.client(), stripeInvoice({ subscription: 'sub_test123' }));
    expect(store.first('payments')!.subscription_id).toBe('sub-row-1');
  });
});

describe('the idempotency ledger', () => {
  it('claims an event once', async () => {
    const store = db();
    const event = { id: 'evt_1', type: 'invoice.paid', api_version: null, created: at('2026-09-21T12:00:00Z') };

    expect(await claimEvent(store.client(), event as never)).toBe(true);
    expect(await claimEvent(store.client(), event as never)).toBe(false);
    expect(store.rows('stripe_events')).toHaveLength(1);
  });

  it('makes a redelivered event a no-op', async () => {
    const store = db();
    const event = stripeEvent('invoice.paid', stripeInvoice({ status: 'paid', amount_paid: 150000 }));

    const first = await applyEvent(store.client(), event as unknown as Stripe.Event);
    const second = await applyEvent(store.client(), event as unknown as Stripe.Event);

    expect(first.status).toBe('processed');
    expect(second.status).toBe('duplicate');
    expect(store.rows('payments')).toHaveLength(1);
  });

  it('records the outcome, so a failure is findable afterwards', async () => {
    const store = db();
    const event = stripeEvent('invoice.paid', stripeInvoice());
    await applyEvent(store.client(), event as unknown as Stripe.Event);

    const ledger = store.first('stripe_events')!;
    expect(ledger.status).toBe('processed');
    expect(ledger.processed_at).toBeTruthy();
    expect(ledger.error).toBeNull();
  });

  it('records an event it has no handler for, rather than dropping it', async () => {
    const store = db();
    const event = stripeEvent('customer.discount.created', { id: 'di_1' });
    const outcome = await applyEvent(store.client(), event as unknown as Stripe.Event);

    expect(outcome.status).toBe('ignored');
    expect(store.first('stripe_events')!.type).toBe('customer.discount.created');
  });
});

describe('subscriptions', () => {
  it('mirrors a new subscription and attributes it', async () => {
    const store = db();
    await applyEvent(
      store.client(),
      stripeEvent('customer.subscription.created', stripeSubscription()) as unknown as Stripe.Event
    );

    const row = store.first('subscriptions')!;
    expect(row.client_id).toBe(CLIENT_ID);
    expect(row.status).toBe('active');
    expect(row.amount).toBe(1500);
  });

  it('applies a cancellation', async () => {
    const store = db();
    await applyEvent(
      store.client(),
      stripeEvent('customer.subscription.created', stripeSubscription()) as unknown as Stripe.Event
    );
    await applyEvent(
      store.client(),
      stripeEvent('customer.subscription.deleted', stripeSubscription({
        status: 'canceled',
        canceled_at: at('2026-10-01T00:00:00Z'),
        ended_at: at('2026-10-01T00:00:00Z')
      })) as unknown as Stripe.Event
    );

    expect(store.rows('subscriptions')).toHaveLength(1);
    expect(store.first('subscriptions')!.status).toBe('canceled');
  });
});

/**
 * A refunded invoice is still `paid` at Stripe, so the refund has to be read
 * from the charge — otherwise money that went back keeps counting as collected.
 */
describe('refunds', () => {
  function charge(overrides: Record<string, unknown> = {}) {
    return {
      id: 'ch_test',
      object: 'charge',
      currency: 'gbp',
      amount: 150000,
      amount_refunded: 150000,
      payment_intent: 'pi_test',
      ...overrides
    } as unknown as Stripe.Charge;
  }

  it('marks a fully refunded invoice as refunded', async () => {
    const store = db({
      payments: [
        {
          id: 'pay-1',
          stripe_invoice_id: 'in_test123',
          stripe_payment_intent_id: 'pi_test',
          status: 'paid',
          amount_paid: 1500,
          amount_refunded: 0,
          last_event_at: null
        }
      ]
    });

    const result = await recordRefund(store.client(), charge(), { eventAt: '2026-09-22T09:00:00Z' });

    expect(result.applied).toBe(true);
    expect(store.first('payments')!.status).toBe('refunded');
    expect(store.first('payments')!.amount_refunded).toBe(1500);
  });

  /**
   * Stripe sends the running total on every `charge.refunded`. Adding to the
   * stored value would double-count a redelivery.
   */
  it('sets the refunded total rather than adding to it', async () => {
    const store = db({
      payments: [
        {
          id: 'pay-1',
          stripe_payment_intent_id: 'pi_test',
          status: 'refunded',
          amount_paid: 1500,
          amount_refunded: 250,
          last_event_at: null
        }
      ]
    });

    await recordRefund(store.client(), charge({ amount_refunded: 25000 }), {
      eventAt: '2026-09-22T09:00:00Z'
    });
    expect(store.first('payments')!.amount_refunded).toBe(250);
  });

  it('says so when there is no invoice to attach the refund to', async () => {
    const store = db();
    const result = await recordRefund(store.client(), charge());
    expect(result.applied).toBe(false);
    expect(result.detail).toMatch(/No recorded invoice/);
  });
});

/**
 * The signature is the whole security model of the webhook: an unsigned POST to
 * that URL is an attempt to write revenue figures. These use the SDK's own
 * signer and verifier, so a signature that passes here would pass in
 * production.
 */
describe('webhook signatures', () => {
  const SECRET = 'whsec_testsecret';
  const stripe = new Stripe('sk_test_x');

  it('accepts a correctly signed payload', () => {
    const event = stripeEvent('invoice.paid', stripeInvoice());
    const { payload, signature } = signedEvent(event, SECRET);

    const verified = stripe.webhooks.constructEvent(payload, signature, SECRET);
    expect(verified.type).toBe('invoice.paid');
  });

  it('rejects a payload altered after signing', () => {
    const event = stripeEvent('invoice.paid', stripeInvoice({ total: 150000 }));
    const { payload, signature } = signedEvent(event, SECRET);
    // Someone raising the amount on a signed event.
    const tampered = payload.replace('150000', '9900000');

    expect(() => stripe.webhooks.constructEvent(tampered, signature, SECRET)).toThrow();
  });

  it('rejects a signature made with a different secret', () => {
    const event = stripeEvent('invoice.paid', stripeInvoice());
    const { payload, signature } = signedEvent(event, 'whsec_someoneelse');
    expect(() => stripe.webhooks.constructEvent(payload, signature, SECRET)).toThrow();
  });

  /**
   * The tolerance window is what stops a captured request being replayed
   * tomorrow. Verified rather than assumed, because it is the part of the
   * scheme most easily lost by reimplementing it.
   */
  it('rejects a signature older than the tolerance window', () => {
    const event = stripeEvent('invoice.paid', stripeInvoice());
    const yesterday = Math.floor(Date.now() / 1000) - 86_400;
    const { payload, signature } = signedEvent(event, SECRET, { timestamp: yesterday });

    expect(() => stripe.webhooks.constructEvent(payload, signature, SECRET, 300)).toThrow(
      /timestamp/i
    );
  });

  it('rejects a missing signature header', () => {
    const { payload } = signedEvent(stripeEvent('invoice.paid', stripeInvoice()), SECRET);
    expect(() => stripe.webhooks.constructEvent(payload, '', SECRET)).toThrow();
  });
});

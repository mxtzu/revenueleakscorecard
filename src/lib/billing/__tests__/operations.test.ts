import { describe, expect, it } from 'vitest';

import { stripeClient } from '../client';
import {
  cancelSubscription,
  createInvoice,
  createSubscription,
  ensureCustomer,
  sendInvoice,
  voidInvoice
} from '../operations';
import {
  CLIENT_ID,
  CUSTOMER_ID,
  crmClientRow,
  FakeDb,
  FakeStripe,
  stripeInvoice,
  stripeSubscription
} from './fakes';

const ENV = { STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_CURRENCY: 'gbp' };

function setup(clientOverrides: Record<string, unknown> = {}) {
  const fake = new FakeStripe();
  const db = new FakeDb({
    clients: [crmClientRow(clientOverrides)],
    payments: [],
    subscriptions: [],
    stripe_events: []
  });
  const stripe = stripeClient({ env: ENV, httpClient: fake.httpClient() });
  return { fake, db, stripe };
}

const CLIENT = {
  id: CLIENT_ID,
  company_name: 'Riverside Dental',
  stripe_customer_id: CUSTOMER_ID,
  billing_email: 'accounts@riverside.test'
};

describe('customers', () => {
  it('reuses the customer a client already has', async () => {
    const { fake, db, stripe } = setup();
    const id = await ensureCustomer(stripe, db.client(), CLIENT);

    expect(id).toBe(CUSTOMER_ID);
    expect(fake.calls).toHaveLength(0); // no Stripe round trip at all
  });

  it('creates one and links it back', async () => {
    const { fake, db, stripe } = setup({ stripe_customer_id: null });
    fake.respondWith({ id: 'cus_new', object: 'customer' });

    const id = await ensureCustomer(stripe, db.client(), {
      ...CLIENT,
      stripe_customer_id: null
    });

    expect(id).toBe('cus_new');
    expect(db.first('clients')!.stripe_customer_id).toBe('cus_new');
    // The link back, so a customer in the Stripe dashboard is traceable.
    expect(fake.paramsOf(fake.calls[0]).get('metadata[crm_client_id]')).toBe(CLIENT_ID);
  });

  it('sends an idempotency key, so a double submit makes one customer', async () => {
    const { fake, db, stripe } = setup({ stripe_customer_id: null });
    fake.respondWith({ id: 'cus_new', object: 'customer' });
    await ensureCustomer(stripe, db.client(), { ...CLIENT, stripe_customer_id: null });

    expect(fake.calls[0].headers['idempotency-key']).toContain(CLIENT_ID);
  });
});

describe('invoices', () => {
  it('adds the items before creating the invoice', async () => {
    // Stripe attaches pending items to the *next* invoice for that customer.
    // Reversed, this produces an empty invoice and orphaned items that ambush
    // the following one.
    const { fake, db, stripe } = setup();
    fake.respondWith(
      { id: 'ii_1', object: 'invoiceitem' },
      stripeInvoice({ status: 'draft' })
    );

    await createInvoice(stripe, db.client(), {
      client: CLIENT,
      lines: [{ description: 'September retainer', amount: 1500 }]
    });

    expect(fake.calls[0].path).toContain('/v1/invoiceitems');
    expect(fake.calls[1].path).toContain('/v1/invoices');
  });

  it('converts the amount to minor units', async () => {
    const { fake, db, stripe } = setup();
    fake.respondWith({ id: 'ii_1' }, stripeInvoice({ status: 'draft' }));

    await createInvoice(stripe, db.client(), {
      client: CLIENT,
      lines: [{ description: 'Landing page', amount: 1499.99 }]
    });

    expect(fake.paramsOf(fake.calls[0]).get('amount')).toBe('149999');
  });

  it('multiplies out a quantity and says so on the line', async () => {
    const { fake, db, stripe } = setup();
    fake.respondWith({ id: 'ii_1' }, stripeInvoice({ status: 'draft' }));

    await createInvoice(stripe, db.client(), {
      client: CLIENT,
      lines: [{ description: 'Landing page', amount: 800, quantity: 3 }]
    });

    const params = fake.paramsOf(fake.calls[0]);
    expect(params.get('amount')).toBe('240000');
    expect(params.get('description')).toContain('3 ×');
  });

  /**
   * Drafting must not email anybody. That is `send`, and keeping them apart is
   * what makes "draft it now, review it, send it later" possible.
   */
  it('creates a draft that does not advance on its own', async () => {
    const { fake, db, stripe } = setup();
    fake.respondWith({ id: 'ii_1' }, stripeInvoice({ status: 'draft' }));

    await createInvoice(stripe, db.client(), {
      client: CLIENT,
      lines: [{ description: 'Retainer', amount: 1500 }]
    });

    const params = fake.paramsOf(fake.calls[1]);
    expect(params.get('auto_advance')).toBe('false');
    expect(params.get('collection_method')).toBe('send_invoice');
    // Nothing was finalised and nothing was sent.
    expect(fake.callsTo('/finalize')).toHaveLength(0);
    expect(fake.callsTo('/send')).toHaveLength(0);
  });

  it('finalises without sending when asked to finalise', async () => {
    const { fake, db, stripe } = setup();
    fake.respondWith(
      { id: 'ii_1' },
      stripeInvoice({ status: 'draft' }),
      stripeInvoice({ status: 'open' })
    );

    await createInvoice(stripe, db.client(), {
      client: CLIENT,
      lines: [{ description: 'Retainer', amount: 1500 }],
      finalize: true
    });

    expect(fake.callsTo('/finalize')).toHaveLength(1);
    expect(fake.callsTo('/send')).toHaveLength(0);
  });

  it('sends only when explicitly told to', async () => {
    const { fake, db, stripe } = setup();
    fake.respondWith(
      { id: 'ii_1' },
      stripeInvoice({ status: 'draft' }),
      stripeInvoice({ status: 'open' }),
      stripeInvoice({ status: 'open' })
    );

    await createInvoice(stripe, db.client(), {
      client: CLIENT,
      lines: [{ description: 'Retainer', amount: 1500 }],
      send: true
    });

    expect(fake.callsTo('/send')).toHaveLength(1);
  });

  it('records the result from Stripe’s response, not from the request', async () => {
    // The whole "Stripe is the source of truth" rule, in one assertion: the row
    // says what Stripe said, not what was asked for.
    const { fake, db, stripe } = setup();
    fake.respondWith({ id: 'ii_1' }, stripeInvoice({ status: 'draft', total: 150000 }));

    await createInvoice(stripe, db.client(), {
      client: CLIENT,
      lines: [{ description: 'Retainer', amount: 1500 }]
    });

    const payment = db.first('payments')!;
    expect(payment.stripe_invoice_id).toBe('in_test123');
    expect(payment.stripe_status).toBe('draft');
    expect(payment.status).toBe('pending');
    expect(payment.client_id).toBe(CLIENT_ID);
  });

  it('refuses an invoice with no lines', async () => {
    const { db, stripe } = setup();
    await expect(
      createInvoice(stripe, db.client(), { client: CLIENT, lines: [] })
    ).rejects.toThrow(/at least one line/);
  });

  it('voids rather than deletes', async () => {
    // Destroying the record of something a client was asked to pay is not an
    // accounting practice.
    const { fake, db, stripe } = setup();
    fake.respondWith(stripeInvoice({ status: 'void' }));

    await voidInvoice(stripe, db.client(), 'in_test123');

    expect(fake.calls[0].path).toContain('/void');
    expect(db.first('payments')!.status).toBe('cancelled');
  });

  it('records the sent invoice when it goes out', async () => {
    const { fake, db, stripe } = setup();
    fake.respondWith(stripeInvoice({ status: 'open' }));

    await sendInvoice(stripe, db.client(), 'in_test123');

    expect(fake.calls[0].path).toContain('/send');
    expect(db.first('payments')!.hosted_invoice_url).toBe('https://invoice.stripe.com/i/test');
  });
});

describe('subscriptions', () => {
  it('creates a product, then the subscription priced against it', async () => {
    // price_data takes a Product id in this API version; inline product_data
    // was removed.
    const { fake, db, stripe } = setup();
    fake.respondWith({ id: 'prod_1', object: 'product' }, stripeSubscription());

    await createSubscription(stripe, db.client(), { client: CLIENT, amount: 1500 });

    expect(fake.calls[0].path).toContain('/v1/products');
    const params = fake.paramsOf(fake.calls[1]);
    expect(params.get('items[0][price_data][product]')).toBe('prod_1');
    expect(params.get('items[0][price_data][unit_amount]')).toBe('150000');
    expect(params.get('items[0][price_data][recurring][interval]')).toBe('month');
  });

  it('mirrors the subscription Stripe returned', async () => {
    const { fake, db, stripe } = setup();
    fake.respondWith({ id: 'prod_1' }, stripeSubscription());

    await createSubscription(stripe, db.client(), { client: CLIENT, amount: 1500 });

    const row = db.first('subscriptions')!;
    expect(row.stripe_subscription_id).toBe('sub_test123');
    expect(row.status).toBe('active');
    expect(row.client_id).toBe(CLIENT_ID);
  });

  it('refuses a subscription with no value', async () => {
    const { db, stripe } = setup();
    await expect(
      createSubscription(stripe, db.client(), { client: CLIENT, amount: 0 })
    ).rejects.toThrow(/above zero/);
  });

  /**
   * Immediate cancellation takes away service already paid for, so ending at
   * the period boundary is the default and immediacy is the explicit choice.
   */
  it('cancels at the end of the period by default', async () => {
    const { fake, db, stripe } = setup();
    fake.respondWith(stripeSubscription({ cancel_at_period_end: true }));

    await cancelSubscription(stripe, db.client(), 'sub_test123');

    expect(fake.calls[0].method).toBe('POST');
    expect(fake.paramsOf(fake.calls[0]).get('cancel_at_period_end')).toBe('true');
    expect(db.first('subscriptions')!.cancel_at_period_end).toBe(true);
  });

  it('cancels immediately when asked', async () => {
    const { fake, db, stripe } = setup();
    fake.respondWith(stripeSubscription({ status: 'canceled' }));

    await cancelSubscription(stripe, db.client(), 'sub_test123', { immediately: true });

    expect(fake.calls[0].method).toBe('DELETE');
    expect(db.first('subscriptions')!.status).toBe('canceled');
  });
});

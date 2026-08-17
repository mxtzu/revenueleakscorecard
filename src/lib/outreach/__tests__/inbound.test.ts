import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { recordDeliveryEvent, recordInbound } from '../inbound';
import {
  ProviderError,
  resendProvider,
  twilioProvider,
  verifySvixSignature,
  verifyTwilioSignature
} from '../providers';
import { contact, FakeDb, intelligence, LEAD_ID, lead } from './fakes';

function db(extra: Record<string, Record<string, unknown>[]> = {}) {
  return new FakeDb({
    crm_leads: [lead()],
    lead_intelligence: [intelligence()],
    contacts: [contact()],
    lead_outreach: [],
    outreach_messages: [],
    inbound_messages: [],
    activities: [],
    suppressions: [],
    provider_events: [],
    ...extra
  });
}

const REPLY = {
  channel: 'email' as const,
  fromEmail: 'dana@riverside.test',
  toEmail: 'hello@ascend.test',
  subject: 'Re: Quick question',
  body: 'Yes, Thursday works. What time?',
  provider: 'resend',
  providerMessageId: 'in_1'
};

describe('recording a reply', () => {
  it('matches the sender to a contact', async () => {
    const store = db();
    const outcome = await recordInbound(store.client(), REPLY);

    expect(outcome.status).toBe('recorded');
    expect(outcome.leadId).toBe(LEAD_ID);
    expect(store.first('inbound_messages')!.crm_lead_id).toBe(LEAD_ID);
  });

  /**
   * Reply detection does not stop sequences itself. It writes an inbound
   * activity, and `halt_outreach_on_inbound_reply` — the trigger from the first
   * migration — does the stopping. This asserts the activity is written the way
   * that trigger needs.
   */
  it('writes the inbound activity the stop trigger fires on', async () => {
    const store = db();
    await recordInbound(store.client(), REPLY);

    const activity = store.first('activities')!;
    expect(activity.direction).toBe('inbound');
    expect(activity.type).toBe('email');
    expect(activity.crm_lead_id).toBe(LEAD_ID);
  });

  it('matches on the published business address when there is no contact', async () => {
    const store = db({ contacts: [] });
    const outcome = await recordInbound(store.client(), {
      ...REPLY,
      fromEmail: 'info@riverside.test'
    });
    expect(outcome.leadId).toBe(LEAD_ID);
  });

  it('keeps a reply it cannot match rather than dropping it', async () => {
    // Somebody answered something. Silently discarding that is worse than
    // filing it unattributed.
    const store = db();
    const outcome = await recordInbound(store.client(), {
      ...REPLY,
      fromEmail: 'stranger@nowhere.test'
    });

    expect(outcome.status).toBe('unmatched');
    expect(store.rows('inbound_messages')).toHaveLength(1);
    expect(store.rows('activities')).toHaveLength(0);
  });

  it('is idempotent on a redelivered webhook', async () => {
    const store = db();
    await recordInbound(store.client(), REPLY);
    const second = await recordInbound(store.client(), REPLY);

    expect(second.status).toBe('duplicate');
    expect(store.rows('inbound_messages')).toHaveLength(1);
    expect(store.rows('activities')).toHaveLength(1);
  });
});

describe('opt-outs', () => {
  it('suppresses the address and says so', async () => {
    const store = db();
    const outcome = await recordInbound(store.client(), {
      ...REPLY,
      body: 'Please remove me from your list.'
    });

    expect(outcome.optedOut).toBe(true);
    const suppression = store.first('suppressions')!;
    expect(suppression.email).toBe('dana@riverside.test');
    expect(suppression.reason).toBe('unsubscribed');
    expect(suppression.crm_lead_id).toBe(LEAD_ID);
  });

  it('suppresses a STOP text by number', async () => {
    const store = db();
    await recordInbound(store.client(), {
      channel: 'sms',
      fromPhone: '+44 7700 900222',
      toPhone: '+447700900000',
      body: 'STOP',
      provider: 'twilio',
      providerMessageId: 'SM1'
    });

    // Normalised on the way in, so the same number written three ways
    // suppresses once.
    expect(store.first('suppressions')!.phone).toBe('+447700900222');
  });

  it('suppresses even when the sender matches no lead', async () => {
    // Consent does not depend on being in the CRM.
    const store = db();
    const outcome = await recordInbound(store.client(), {
      ...REPLY,
      fromEmail: 'stranger@nowhere.test',
      body: 'unsubscribe'
    });

    expect(outcome.status).toBe('unmatched');
    expect(store.first('suppressions')!.email).toBe('stranger@nowhere.test');
  });

  it('does not opt out a genuine reply that quotes our footer', async () => {
    const store = db();
    const outcome = await recordInbound(store.client(), {
      ...REPLY,
      body: 'Sounds good.\n\nOn Mon, Ascend wrote:\n> Unsubscribe: https://crm.test/u?token=x'
    });

    expect(outcome.optedOut).toBe(false);
    expect(store.rows('suppressions')).toHaveLength(0);
  });
});

describe('delivery events', () => {
  function withMessage(status = 'sent') {
    return db({
      outreach_messages: [
        {
          id: 'm1',
          provider: 'resend',
          provider_message_id: 'msg-1',
          to_email: 'dana@riverside.test',
          crm_lead_id: LEAD_ID,
          status,
          last_event_at: null
        }
      ]
    });
  }

  it('marks a delivery', async () => {
    const store = withMessage();
    const outcome = await recordDeliveryEvent(store.client(), {
      type: 'email.delivered',
      provider: 'resend',
      providerMessageId: 'msg-1'
    });

    expect(outcome.applied).toBe(true);
    expect(store.first('outreach_messages')!.status).toBe('delivered');
    expect(store.first('outreach_messages')!.delivered_at).toBeTruthy();
  });

  /**
   * The reason for tracking bounces at all: continuing to mail an address that
   * hard-bounced is how a sending domain gets blocked.
   */
  it('suppresses an address that bounced', async () => {
    const store = withMessage();
    await recordDeliveryEvent(store.client(), {
      type: 'email.bounced',
      provider: 'resend',
      providerMessageId: 'msg-1'
    });

    expect(store.first('outreach_messages')!.status).toBe('bounced');
    expect(store.first('suppressions')!.email).toBe('dana@riverside.test');
    expect(store.first('suppressions')!.reason).toBe('bounced');
  });

  it('suppresses an address that reported spam', async () => {
    const store = withMessage();
    await recordDeliveryEvent(store.client(), {
      type: 'email.complained',
      provider: 'resend',
      providerMessageId: 'msg-1'
    });
    expect(store.first('suppressions')!.reason).toBe('complained');
  });

  it('does not suppress on an open or a click', async () => {
    const store = withMessage();
    await recordDeliveryEvent(store.client(), {
      type: 'email.opened',
      provider: 'resend',
      providerMessageId: 'msg-1'
    });
    expect(store.rows('suppressions')).toHaveLength(0);
  });

  it('says so when the event names a message it has never sent', async () => {
    const store = db();
    const outcome = await recordDeliveryEvent(store.client(), {
      type: 'email.delivered',
      provider: 'resend',
      providerMessageId: 'unknown'
    });
    expect(outcome.applied).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------
describe('the email provider', () => {
  function transport(status: number, body: unknown) {
    const calls: { url: string; body?: string; headers?: Record<string, string> }[] = [];
    return {
      calls,
      send: async (request: { url: string; body?: string; headers?: Record<string, string> }) => {
        calls.push(request);
        return { status, body: JSON.stringify(body) };
      }
    };
  }

  it('sends the message and returns the provider id', async () => {
    const t = transport(200, { id: 'resend-1' });
    const result = await resendProvider('re_key').send(
      {
        to: 'dana@riverside.test',
        from: 'hello@ascend.test',
        fromName: 'Ascend',
        subject: 'Hello',
        text: 'Body',
        headers: { 'List-Unsubscribe': '<https://crm.test/u>' }
      },
      t.send
    );

    expect(result.providerMessageId).toBe('resend-1');
    const sent = JSON.parse(t.calls[0].body as string);
    expect(sent.from).toBe('Ascend <hello@ascend.test>');
    expect(sent.to).toEqual(['dana@riverside.test']);
    expect(sent.headers['List-Unsubscribe']).toBe('<https://crm.test/u>');
    expect(t.calls[0].headers?.authorization).toBe('Bearer re_key');
  });

  it('marks a rate limit retryable and a rejection not', async () => {
    // Retrying a 4xx just burns sending reputation.
    const rateLimited = transport(429, { message: 'Too many requests' });
    await expect(
      resendProvider('k').send({ to: 'a@b.test', from: 'c@d.test', subject: 's', text: 't' }, rateLimited.send)
    ).rejects.toMatchObject({ retryable: true });

    const rejected = transport(422, { message: 'Invalid recipient' });
    await expect(
      resendProvider('k').send({ to: 'a@b.test', from: 'c@d.test', subject: 's', text: 't' }, rejected.send)
    ).rejects.toMatchObject({ retryable: false });
  });

  it('sends SMS as form-encoded with basic auth', async () => {
    const t = transport(201, { sid: 'SM123' });
    const result = await twilioProvider('AC1', 'token').send(
      { to: '+447700900222', from: '+447700900000', text: 'Hello' },
      t.send
    );

    expect(result.providerMessageId).toBe('SM123');
    const params = new URLSearchParams(t.calls[0].body as string);
    expect(params.get('To')).toBe('+447700900222');
    expect(params.get('Body')).toBe('Hello');
    expect(t.calls[0].headers?.authorization).toMatch(/^Basic /);
    // The token must never travel in the URL.
    expect(t.calls[0].url).not.toContain('token');
  });

  it('carries a ProviderError rather than a bare Error', async () => {
    const t = transport(500, { message: 'upstream' });
    await expect(
      twilioProvider('AC1', 'tok').send({ to: '+1', from: '+2', text: 'x' }, t.send)
    ).rejects.toBeInstanceOf(ProviderError);
  });
});

/**
 * The webhook signature is the whole security model of the inbound routes: an
 * unsigned POST is an attempt to forge a reply, and a forged opt-out reply
 * would suppress a real prospect.
 */
describe('inbound signatures', () => {
  const SECRET = `whsec_${Buffer.from('super-secret-key').toString('base64')}`;

  function svixSign(body: string, id: string, timestamp: string, secret = SECRET) {
    const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
    return `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64')}`;
  }

  const NOW = new Date('2026-09-16T10:00:00Z');
  const TS = String(Math.floor(NOW.getTime() / 1000));
  const BODY = JSON.stringify({ type: 'email.delivered' });

  it('accepts a correctly signed payload', () => {
    expect(
      verifySvixSignature({
        secret: SECRET,
        id: 'msg_1',
        timestamp: TS,
        signature: svixSign(BODY, 'msg_1', TS),
        body: BODY,
        now: NOW
      })
    ).toBe(true);
  });

  it('rejects a payload altered after signing', () => {
    expect(
      verifySvixSignature({
        secret: SECRET,
        id: 'msg_1',
        timestamp: TS,
        signature: svixSign(BODY, 'msg_1', TS),
        body: JSON.stringify({ type: 'email.bounced' }),
        now: NOW
      })
    ).toBe(false);
  });

  it('rejects a signature from a different secret', () => {
    const other = `whsec_${Buffer.from('someone-elses-key').toString('base64')}`;
    expect(
      verifySvixSignature({
        secret: SECRET,
        id: 'msg_1',
        timestamp: TS,
        signature: svixSign(BODY, 'msg_1', TS, other),
        body: BODY,
        now: NOW
      })
    ).toBe(false);
  });

  it('rejects a captured request replayed later', () => {
    // Without the tolerance window a captured POST stays valid forever.
    const yesterday = String(Math.floor(NOW.getTime() / 1000) - 86_400);
    expect(
      verifySvixSignature({
        secret: SECRET,
        id: 'msg_1',
        timestamp: yesterday,
        signature: svixSign(BODY, 'msg_1', yesterday),
        body: BODY,
        now: NOW
      })
    ).toBe(false);
  });

  it('accepts one of several signatures during a secret rotation', () => {
    const other = `whsec_${Buffer.from('rotating-key-here').toString('base64')}`;
    const both = `${svixSign(BODY, 'msg_1', TS, other)} ${svixSign(BODY, 'msg_1', TS)}`;
    expect(
      verifySvixSignature({ secret: SECRET, id: 'msg_1', timestamp: TS, signature: both, body: BODY, now: NOW })
    ).toBe(true);
  });

  it('rejects a missing header outright', () => {
    expect(
      verifySvixSignature({ secret: SECRET, id: null, timestamp: TS, signature: 'v1,x', body: BODY, now: NOW })
    ).toBe(false);
    expect(
      verifySvixSignature({ secret: SECRET, id: 'm', timestamp: TS, signature: null, body: BODY, now: NOW })
    ).toBe(false);
  });

  it('verifies Twilio’s scheme over the URL and sorted params', () => {
    const url = 'https://crm.test/api/crm/outreach/sms';
    const params = { From: '+447700900222', Body: 'STOP', To: '+447700900000' };
    const expected = createHmac('sha1', 'auth-token')
      .update(url + 'Body' + 'STOP' + 'From' + '+447700900222' + 'To' + '+447700900000')
      .digest('base64');

    expect(verifyTwilioSignature({ authToken: 'auth-token', url, params, signature: expected })).toBe(
      true
    );
    // A changed parameter invalidates it.
    expect(
      verifyTwilioSignature({
        authToken: 'auth-token',
        url,
        params: { ...params, Body: 'YES' },
        signature: expected
      })
    ).toBe(false);
    expect(verifyTwilioSignature({ authToken: 'auth-token', url, params, signature: null })).toBe(
      false
    );
  });
});

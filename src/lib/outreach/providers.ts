/**
 * Email and SMS providers.
 *
 * One interface, two adapters, and an injectable transport — the same shape as
 * the calendar integration, for the same reason: the request this code builds
 * is the half it is responsible for, and it has to be assertable without a
 * network or a live account.
 *
 * Resend for email and Twilio for SMS, because both have small stable REST
 * APIs and both publish a webhook signing scheme that can be verified properly
 * rather than approximated. Adding a third is implementing this interface.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export interface HttpRequest {
  method: 'GET' | 'POST';
  url: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface HttpResponse {
  status: number;
  body: string;
}

export type Transport = (request: HttpRequest) => Promise<HttpResponse>;

export function defaultTransport(): Transport {
  return async ({ method, url, headers, body }) => {
    const response = await fetch(url, { method, headers, body });
    return { status: response.status, body: await response.text() };
  };
}

export class ProviderError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Worth retrying, as opposed to a message that will never be accepted. */
    readonly retryable: boolean
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export interface SendEmailInput {
  to: string;
  from: string;
  fromName?: string | null;
  replyTo?: string | null;
  subject: string;
  /** Plain text. The HTML part is built from it, so there is one source. */
  text: string;
  html?: string;
  headers?: Record<string, string>;
}

export interface SendSmsInput {
  to: string;
  from: string;
  text: string;
}

export interface SendResult {
  providerMessageId: string | null;
  provider: string;
}

export interface EmailProvider {
  readonly name: string;
  send(input: SendEmailInput, transport?: Transport): Promise<SendResult>;
}

export interface SmsProvider {
  readonly name: string;
  send(input: SendSmsInput, transport?: Transport): Promise<SendResult>;
}

function readJson<T>(response: HttpResponse, what: string): T {
  let parsed: unknown = null;
  try {
    parsed = response.body ? JSON.parse(response.body) : null;
  } catch {
    parsed = null;
  }

  if (response.status >= 200 && response.status < 300) return (parsed ?? {}) as T;

  const payload = (parsed ?? {}) as { message?: string; error?: string; name?: string };
  const detail = payload.message ?? payload.error ?? `HTTP ${response.status}`;
  // 429 and 5xx are worth another attempt; a 4xx means the message itself is
  // unacceptable and retrying it just burns sending reputation.
  const retryable = response.status === 429 || response.status >= 500;
  throw new ProviderError(response.status, `${what}: ${detail}`, retryable);
}

// ---------------------------------------------------------------------------
// Resend
// ---------------------------------------------------------------------------
const RESEND_ENDPOINT = 'https://api.resend.com/emails';

export function resendProvider(apiKey: string): EmailProvider {
  return {
    name: 'resend',
    async send(input, transport = defaultTransport()) {
      const response = await transport({
        method: 'POST',
        url: RESEND_ENDPOINT,
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          from: input.fromName ? `${input.fromName} <${input.from}>` : input.from,
          to: [input.to],
          reply_to: input.replyTo ?? undefined,
          subject: input.subject,
          text: input.text,
          html: input.html,
          headers: input.headers
        })
      });

      const payload = readJson<{ id?: string }>(response, 'Could not send the email');
      return { providerMessageId: payload.id ?? null, provider: 'resend' };
    }
  };
}

// ---------------------------------------------------------------------------
// Twilio
// ---------------------------------------------------------------------------
export function twilioProvider(accountSid: string, authToken: string): SmsProvider {
  return {
    name: 'twilio',
    async send(input, transport = defaultTransport()) {
      const response = await transport({
        method: 'POST',
        url: `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`,
        headers: {
          authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
          'content-type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({ To: input.to, From: input.from, Body: input.text }).toString()
      });

      const payload = readJson<{ sid?: string }>(response, 'Could not send the text message');
      return { providerMessageId: payload.sid ?? null, provider: 'twilio' };
    }
  };
}

// ---------------------------------------------------------------------------
// Inbound signature verification
// ---------------------------------------------------------------------------

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Resend (Svix) webhook signatures.
 *
 * Signed payload is `${id}.${timestamp}.${body}`, HMAC-SHA256 under the secret
 * with its `whsec_` prefix stripped and the rest base64-decoded. The header can
 * carry several space-separated `v1,<sig>` values during a secret rotation, so
 * every one is checked.
 *
 * The timestamp tolerance is the part worth not skipping: without it a captured
 * request stays valid forever.
 */
export function verifySvixSignature(options: {
  secret: string;
  id: string | null;
  timestamp: string | null;
  signature: string | null;
  body: string;
  toleranceSeconds?: number;
  now?: Date;
}): boolean {
  const { secret, id, timestamp, signature, body } = options;
  if (!id || !timestamp || !signature) return false;

  const age = Math.abs(
    (options.now ?? new Date()).getTime() / 1000 - Number(timestamp)
  );
  if (!Number.isFinite(age) || age > (options.toleranceSeconds ?? 300)) return false;

  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = createHmac('sha256', key)
    .update(`${id}.${timestamp}.${body}`)
    .digest('base64');

  return signature
    .split(' ')
    .map((part) => part.split(',')[1] ?? '')
    .some((candidate) => candidate.length > 0 && safeEqual(candidate, expected));
}

/**
 * Twilio webhook signatures.
 *
 * HMAC-SHA1 over the full request URL with every POST parameter appended in
 * key order, as `keyvalue`. Twilio signs the URL it was configured with, so a
 * proxy that rewrites the host will fail verification — that is the scheme
 * working, not a bug to route around.
 */
export function verifyTwilioSignature(options: {
  authToken: string;
  url: string;
  params: Record<string, string>;
  signature: string | null;
}): boolean {
  if (!options.signature) return false;

  const payload = Object.keys(options.params)
    .sort()
    .reduce((acc, key) => acc + key + options.params[key], options.url);

  const expected = createHmac('sha1', options.authToken).update(payload).digest('base64');
  return safeEqual(options.signature, expected);
}

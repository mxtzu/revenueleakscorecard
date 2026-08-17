/**
 * Sentry, in the browser.
 *
 * A separate DSN variable on purpose: `NEXT_PUBLIC_SENTRY_DSN` is compiled into
 * the bundle and visible to anyone, which is fine for a DSN (it is an ingest
 * endpoint, not a credential) but means it has to be a deliberate choice rather
 * than the server value leaking into client code.
 *
 * Session replay and performance tracing are off. This is an internal tool
 * whose screens are full of other people's business data, and recording them
 * is a data-protection decision, not a debugging convenience.
 */

import * as Sentry from '@sentry/nextjs';

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  enabled: Boolean(process.env.NEXT_PUBLIC_SENTRY_DSN),
  environment: process.env.NEXT_PUBLIC_VERCEL_ENV ?? process.env.NODE_ENV,
  tracesSampleRate: 0,
  replaysSessionSampleRate: 0,
  replaysOnErrorSampleRate: 0,
  sendDefaultPii: false
});

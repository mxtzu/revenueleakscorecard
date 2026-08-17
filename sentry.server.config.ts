/**
 * Sentry, server side.
 *
 * Silent without `SENTRY_DSN`, which is the state a deployment starts in — the
 * SDK simply does nothing rather than buffering events for a destination that
 * does not exist.
 *
 * `sendDefaultPii` stays off. The interesting objects in this application are
 * leads and their contact details, and shipping a prospect's email address to a
 * third party because an unrelated query failed is not a trade worth making.
 * `src/lib/observability.ts` scrubs anything attached deliberately.
 */

import * as Sentry from '@sentry/nextjs';

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  enabled: Boolean(process.env.SENTRY_DSN),
  environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
  release: process.env.VERCEL_GIT_COMMIT_SHA,
  tracesSampleRate: 0,
  sendDefaultPii: false
});

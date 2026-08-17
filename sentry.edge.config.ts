/**
 * Sentry, edge runtime — the middleware.
 *
 * Separate from the server config because the edge runtime has no Node
 * built-ins and the SDK ships a different build for it.
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

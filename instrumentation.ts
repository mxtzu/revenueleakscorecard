/**
 * Next.js loads this once per runtime, before anything else.
 *
 * The import is conditional on the runtime because the Node and edge builds of
 * the SDK are different packages; importing the wrong one fails the build.
 */

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./sentry.server.config');
  }
  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.edge.config');
  }
}

/*
 * `onRequestError` is deliberately not exported. Next.js only calls that hook
 * from 15.0 onwards and this project is on 14.2, so exporting it would look
 * like server-component errors were being captured when they are not. They are
 * captured instead by `reportError()` at the places that matter — the cron
 * endpoints and the webhooks — which works on both versions.
 */

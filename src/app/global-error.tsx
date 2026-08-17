'use client';

/**
 * The last resort: an error thrown while rendering the root layout itself.
 *
 * The CRM's own `(crm)/error.tsx` catches anything inside a page, which is
 * almost everything. This one exists for the case that boundary cannot catch —
 * a failure in the layout above it — where React has no shell left to render
 * into, which is why it has to supply its own `<html>` and `<body>`.
 *
 * It is also the only place a client-side render error reaches Sentry: the
 * server SDK never sees it, because it never got to the server.
 */

import * as Sentry from '@sentry/nextjs';
import { useEffect } from 'react';

export default function GlobalError({
  error,
  reset
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          fontFamily: 'system-ui, -apple-system, Segoe UI, sans-serif',
          background: '#0b0d12',
          color: '#e8eaee',
          display: 'flex',
          minHeight: '100vh',
          alignItems: 'center',
          justifyContent: 'center',
          margin: 0,
          padding: 24
        }}
      >
        <main style={{ maxWidth: '34rem' }}>
          <h1 style={{ fontSize: '1.4rem', margin: '0 0 .75rem' }}>Something broke badly</h1>
          <p style={{ color: '#9aa1ad', lineHeight: 1.6 }}>
            The application failed before it could render. Nothing was saved. If this persists,
            the reference below identifies it in the logs.
          </p>
          {error.digest ? (
            <p style={{ color: '#6c7380', fontFamily: 'monospace', fontSize: '.8rem' }}>
              {error.digest}
            </p>
          ) : null}
          <button
            type="button"
            onClick={reset}
            style={{
              background: '#3b6ef5',
              color: '#fff',
              border: 0,
              borderRadius: 8,
              padding: '.7rem 1.4rem',
              fontSize: '.95rem',
              cursor: 'pointer',
              marginTop: '1.25rem'
            }}
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}

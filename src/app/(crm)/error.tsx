'use client';

/**
 * Error boundary for every CRM page.
 *
 * Without one, a failed query renders Next's default error screen: a blank page
 * with no way back and no indication of whether the problem is transient. Most
 * failures here are a dropped connection or an expired session, both of which a
 * retry fixes, so the boundary offers one.
 *
 * The message is shown rather than hidden. This is an internal tool behind
 * authentication, and "CRM query failed (listLeads): ..." is the difference
 * between a fixable report and "the leads page is broken".
 */

import Link from 'next/link';
import { useEffect } from 'react';

export default function CrmError({
  error,
  reset
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('CRM page error', error);
  }, [error]);

  const isAuth = /jwt|session|not authenticated|permission denied/i.test(error.message);

  return (
    <div className="mx-auto max-w-xl rounded-xl border border-rose-400/25 bg-ink-900/70 p-6 shadow-card">
      <p className="label-mono text-rose-300">Error</p>
      <h1 className="display mt-1 text-2xl text-white">
        {isAuth ? 'Your session expired' : 'This page did not load'}
      </h1>

      <p className="mt-3 text-sm leading-relaxed text-white/60">
        {isAuth
          ? 'Sign in again to continue. Nothing was lost — the CRM had not written anything.'
          : 'The query behind this page failed. If it keeps happening, the message below is the useful part.'}
      </p>

      <pre className="mt-4 overflow-x-auto whitespace-pre-wrap rounded-lg border border-line bg-ink-800 px-3 py-2 font-mono text-xs text-white/55">
        {error.message}
        {error.digest ? `\n\ndigest: ${error.digest}` : ''}
      </pre>

      <div className="mt-5 flex flex-wrap gap-2">
        {isAuth ? (
          <Link
            href="/login"
            className="rounded-lg bg-electric-500 px-4 py-2 text-sm font-medium text-white hover:bg-electric-600"
          >
            Sign in
          </Link>
        ) : (
          <button
            type="button"
            onClick={reset}
            className="rounded-lg bg-electric-500 px-4 py-2 text-sm font-medium text-white hover:bg-electric-600"
          >
            Try again
          </button>
        )}
        <Link
          href="/dashboard"
          className="rounded-lg border border-line px-4 py-2 text-sm text-white/70 hover:border-electric-500/50"
        >
          Back to dashboard
        </Link>
      </div>
    </div>
  );
}

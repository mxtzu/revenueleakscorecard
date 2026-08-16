/**
 * CRM sign-in.
 *
 * A Server Action rather than a client-side call, so the session cookie is set
 * by the server on the same request and the CRM is usable immediately after
 * redirect. No credentials touch client JavaScript.
 *
 * Accounts are created in the Supabase dashboard (or by an admin invite), not
 * here — a self-serve sign-up on an internal CRM would let anyone with the URL
 * create a profile row.
 */

import Link from 'next/link';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { createServerClient, isCrmConfigured } from '@/lib/crm/supabase';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Sign in | Agency CRM',
  robots: { index: false, follow: false }
};

async function signIn(formData: FormData) {
  'use server';

  const email = String(formData.get('email') ?? '').trim();
  const password = String(formData.get('password') ?? '');
  if (!email || !password) redirect('/login?error=Enter%20your%20email%20and%20password.');

  const client = createServerClient(
    cookies() as unknown as Parameters<typeof createServerClient>[0]
  );
  const { error } = await client.auth.signInWithPassword({ email, password });

  if (error) {
    // Supabase already returns a generic "Invalid login credentials" for both
    // an unknown email and a wrong password; pass it through rather than
    // inventing a message that distinguishes them.
    redirect(`/login?error=${encodeURIComponent(error.message)}`);
  }
  redirect('/dashboard');
}

export default function LoginPage({
  searchParams
}: {
  searchParams?: { error?: string };
}) {
  const error = searchParams?.error;

  return (
    <div className="flex min-h-screen items-center justify-center bg-ink-950 px-5 py-12">
      <div className="w-full max-w-sm rounded-xl border border-line bg-ink-900/70 p-6 shadow-card">
        <span className="label-mono text-electric-300">Agency</span>
        <h1 className="display mt-1 text-2xl text-white">CRM sign in</h1>

        {!isCrmConfigured() ? (
          <p className="mt-4 text-sm text-amber-200">
            Supabase is not configured on this deployment. See{' '}
            <code className="font-mono">.env.example</code>.
          </p>
        ) : (
          <form action={signIn} className="mt-6 space-y-4">
            <label className="block">
              <span className="label-mono text-white/40">Email</span>
              <input
                type="email"
                name="email"
                autoComplete="username"
                required
                className="mt-1.5 w-full rounded-lg border border-line bg-ink-800 px-3 py-2 text-sm text-white placeholder:text-white/25"
                placeholder="you@agency.com"
              />
            </label>
            <label className="block">
              <span className="label-mono text-white/40">Password</span>
              <input
                type="password"
                name="password"
                autoComplete="current-password"
                required
                className="mt-1.5 w-full rounded-lg border border-line bg-ink-800 px-3 py-2 text-sm text-white"
              />
            </label>

            {error ? (
              <p role="alert" className="text-sm text-rose-300">
                {error}
              </p>
            ) : null}

            <button
              type="submit"
              className="w-full rounded-lg bg-electric-500 px-4 py-2 text-sm font-medium text-white hover:bg-electric-600"
            >
              Sign in
            </button>
          </form>
        )}

        <p className="mt-6 text-xs text-white/35">
          <Link href="/" className="underline-offset-2 hover:underline">
            Back to the scorecard
          </Link>
        </p>
      </div>
    </div>
  );
}

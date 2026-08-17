/**
 * Shell for every CRM route.
 *
 * A route group, so the paths stay at the root (/leads, /pipeline, ...) and the
 * marketing site at "/" is untouched.
 *
 * The shell resolves the signed-in profile once and renders one of three
 * states, deliberately distinguishable:
 *
 *   - Supabase not configured  -> setup instructions, no query attempted
 *   - configured, signed out   -> sign-in prompt
 *   - signed in                -> the app
 *
 * An empty dashboard because you are signed out looks identical to an empty
 * dashboard because you have no leads, so the shell never lets that happen.
 */

import Link from 'next/link';
import type { ReactNode } from 'react';

import { Nav } from '@/components/crm/Nav';
import { crmSession, isCrmConfigured } from '@/lib/crm/server';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Agency CRM',
  robots: { index: false, follow: false }
};

function Frame({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="min-h-screen bg-ink-950">
      <div className="mx-auto flex max-w-[1400px] flex-col gap-8 px-5 py-8 lg:flex-row lg:px-8">
        <aside className="lg:w-56 lg:shrink-0">
          <Link href="/dashboard" className="mb-6 block">
            <span className="label-mono text-electric-300">Agency</span>
            <span className="display block text-xl text-white">CRM</span>
          </Link>
          {aside}
        </aside>
        <main className="min-w-0 flex-1 pb-16">{children}</main>
      </div>
    </div>
  );
}

export default async function CrmLayout({ children }: { children: ReactNode }) {
  if (!isCrmConfigured()) {
    return (
      <Frame>
        <div className="max-w-xl rounded-xl border border-line bg-ink-900/70 p-6 shadow-card">
          <h1 className="display text-2xl text-white">CRM not configured</h1>
          <p className="mt-3 text-sm leading-relaxed text-white/60">
            Set <code className="font-mono text-electric-300">NEXT_PUBLIC_SUPABASE_URL</code> and{' '}
            <code className="font-mono text-electric-300">NEXT_PUBLIC_SUPABASE_ANON_KEY</code> in{' '}
            <code className="font-mono">.env.local</code>, then apply{' '}
            <code className="font-mono">supabase/migrations/20260815_create_agency_crm.sql</code>.
            See <code className="font-mono">.env.example</code>.
          </p>
        </div>
      </Frame>
    );
  }

  const { profile } = await crmSession();

  if (!profile) {
    return (
      <Frame>
        <div className="max-w-xl rounded-xl border border-line bg-ink-900/70 p-6 shadow-card">
          <h1 className="display text-2xl text-white">Sign in required</h1>
          <p className="mt-3 text-sm leading-relaxed text-white/60">
            Every CRM table is protected by row level security, so the data is invisible until
            you are authenticated.
          </p>
          <Link
            href="/login"
            className="mt-5 inline-flex rounded-lg bg-electric-500 px-4 py-2 text-sm font-medium text-white hover:bg-electric-600"
          >
            Sign in
          </Link>
        </div>
      </Frame>
    );
  }

  return (
    <Frame
      aside={
        <>
          <Nav />
          <div className="mt-8 border-t border-line-soft pt-4">
            <p className="truncate text-xs text-white/60">{profile.full_name ?? profile.email}</p>
            <p className="label-mono mt-1 text-white/30">{profile.role.replace(/_/g, ' ')}</p>
            <form action="/api/crm/signout" method="post">
              <button
                type="submit"
                className="mt-3 text-xs text-white/40 underline-offset-2 hover:text-white/70 hover:underline"
              >
                Sign out
              </button>
            </form>
          </div>
        </>
      }
    >
      {children}
    </Frame>
  );
}

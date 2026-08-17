/**
 * Session refresh and route gating for the CRM.
 *
 * Supabase access tokens expire after about an hour and are renewed by writing
 * a new cookie. Server Components cannot write cookies — Next throws, and
 * `createServerClient` swallows it — so without this middleware nothing ever
 * persists a refreshed token and every signed-in user is silently logged out
 * once their first hour is up. Middleware is the only place in the App Router
 * that can both read the request cookie and write the response one, which is
 * why the refresh has to live here.
 *
 * It also gates the CRM routes. The pages are already safe without it: every
 * query runs under the user's session and RLS returns nothing to a stranger.
 * The gate exists so an unauthenticated visitor gets a sign-in page instead of
 * a working-looking dashboard full of zeroes.
 */

import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

/** Route prefixes that require a session. */
const PROTECTED = [
  '/dashboard',
  '/leads',
  '/pipeline',
  '/tasks',
  '/calendar',
  '/opportunities',
  '/outreach',
  '/clients',
  '/payments'
];

function isProtected(pathname: string): boolean {
  return PROTECTED.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request: { headers: request.headers } });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  // Unconfigured deployment: let the request through so the layout can render
  // its setup instructions rather than bouncing to a login page that cannot work.
  if (!url || !anonKey) return response;

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      get(name: string) {
        return request.cookies.get(name)?.value;
      },
      set(name: string, value: string, options: CookieOptions) {
        // Update the request too, so anything later in this same pass reads the
        // refreshed token rather than the expired one.
        request.cookies.set({ name, value, ...options });
        response = NextResponse.next({ request: { headers: request.headers } });
        response.cookies.set({ name, value, ...options });
      },
      remove(name: string, options: CookieOptions) {
        request.cookies.set({ name, value: '', ...options });
        response = NextResponse.next({ request: { headers: request.headers } });
        response.cookies.set({ name, value: '', ...options });
      }
    }
  });

  // getUser() revalidates the token against Supabase and triggers the refresh.
  // getSession() would read the cookie without verifying it, which is exactly
  // the check an expired or forged token would pass.
  const {
    data: { user }
  } = await supabase.auth.getUser();

  const { pathname, search } = request.nextUrl;

  if (!user && isProtected(pathname)) {
    const login = new URL('/login', request.url);
    // Remember where they were headed so sign-in returns them there.
    login.searchParams.set('next', `${pathname}${search}`);
    return NextResponse.redirect(login);
  }

  return response;
}

export const config = {
  /**
   * Only the CRM paths and the login page. The marketing site, the scorecard
   * API and static assets never touch Supabase auth, and running an auth
   * round-trip on them would add latency for nothing.
   *
   * `/api/crm/sync-leads` is deliberately absent: it authenticates with a
   * shared secret, not a session, and gating it here would break the importer.
   */
  matcher: [
    '/dashboard/:path*',
    '/leads/:path*',
    '/pipeline/:path*',
    '/tasks/:path*',
    '/calendar/:path*',
    '/opportunities/:path*',
    '/outreach/:path*',
    '/clients/:path*',
    '/payments/:path*',
    '/login'
  ]
};

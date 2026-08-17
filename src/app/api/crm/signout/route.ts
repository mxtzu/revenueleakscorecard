/**
 * POST /api/crm/signout — clears the Supabase session cookie.
 *
 * POST, not GET: a link prefetch or an <img> tag must not be able to sign
 * someone out.
 */

import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

import { createServerClient, isCrmConfigured } from '@/lib/crm/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  if (isCrmConfigured()) {
    const client = createServerClient(
      cookies() as unknown as Parameters<typeof createServerClient>[0]
    );
    await client.auth.signOut();
  }
  return NextResponse.redirect(new URL('/login', request.url), { status: 303 });
}

/**
 * POST /api/crm/calendar/sync — run a sync.
 *
 * Two callers, two ways of authenticating:
 *
 *   a signed-in user  → syncs their own connected calendar, and only theirs.
 *   a scheduler       → `Authorization: Bearer $CALENDAR_SYNC_SECRET` syncs
 *                       every active account.
 *
 * The scheduled path fails closed: without the secret set it answers 503
 * rather than running unauthenticated, the same rule the lead importer uses.
 *
 * POST only. A GET would let a link prefetch or an <img> tag trigger writes to
 * somebody's calendar.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { syncAccount } from '@/lib/calendar/sync';
import type { CalendarAccount, SyncSummary } from '@/lib/calendar/types';
import { canWrite } from '@/lib/crm/permissions';
import { crmSession } from '@/lib/crm/server';
import { createServiceClient, isCrmConfigured, isServiceRoleConfigured } from '@/lib/crm/supabase';
import { secretMatches } from '@/lib/calendar/webhookAuth';
import { reportError } from '@/lib/observability';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  if (!isCrmConfigured() || !isServiceRoleConfigured()) {
    return NextResponse.json(
      { error: 'The CRM is not fully configured; the calendar sync needs the service-role key.' },
      { status: 503 }
    );
  }

  const service = createServiceClient();
  const bearer = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? null;
  const secret = process.env.CALENDAR_SYNC_SECRET;

  // ---- scheduled run -------------------------------------------------------
  if (bearer) {
    if (!secret) {
      return NextResponse.json(
        { error: 'CALENDAR_SYNC_SECRET is not set, so scheduled syncing is disabled.' },
        { status: 503 }
      );
    }
    if (!secretMatches(bearer, secret)) {
      return NextResponse.json({ error: 'Not authorised.' }, { status: 401 });
    }

    const { data, error } = await service
      .from('calendar_accounts')
      .select('*')
      .eq('is_active', true);
    if (error) return NextResponse.json({ error: error.message }, { status: 502 });

    const results: Record<string, SyncSummary> = {};
    for (const account of (data ?? []) as CalendarAccount[]) {
      const summary = await syncAccount(service, account);
      results[account.google_email] = summary;
      // syncAccount records its own failures on the account row, but nobody
      // reads that on a schedule.
      if (summary.errors.length > 0) {
        await reportError(new Error(summary.errors[0]), {
          operation: 'calendar.sync',
          severity: 'warning',
          extra: { account: account.google_email, failed: summary.failed }
        });
      }
    }
    return NextResponse.json({ accounts: Object.keys(results).length, results });
  }

  // ---- a person pressing "sync now" ---------------------------------------
  const { profile } = await crmSession();
  if (!profile) return NextResponse.json({ error: 'Sign in first.' }, { status: 401 });
  if (!canWrite(profile)) {
    return NextResponse.json({ error: 'Your role is read-only.' }, { status: 403 });
  }

  // Scoped to their own profile. The service-role client bypasses RLS, so this
  // filter is the only thing standing between one person's sync button and
  // everybody else's diary.
  const { data, error } = await service
    .from('calendar_accounts')
    .select('*')
    .eq('profile_id', profile.id)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 502 });
  if (!data) return NextResponse.json({ error: 'No calendar is connected.' }, { status: 404 });

  const summary = await syncAccount(service, data as CalendarAccount);
  return NextResponse.json({ summary });
}

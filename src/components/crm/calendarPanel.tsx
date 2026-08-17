/**
 * The Google Calendar connection panel.
 *
 * Four states, and the difference between them matters more than it looks: a
 * calendar that is not configured, not connected, connected, and connected but
 * broken all show an empty schedule. Saying which one it is at the top of the
 * page is the whole job of this component.
 */

import { Badge, Card } from './ui';
import { SubmitButton } from './forms';
import { formatRelative } from '@/lib/crm/format';
import type { CalendarAccount, SyncSummary } from '@/lib/calendar/types';

type Action = (formData: FormData) => void | Promise<void>;

function Line({ children }: { children: React.ReactNode }) {
  return <p className="text-sm leading-relaxed text-white/55">{children}</p>;
}

/** The last run, in a sentence. */
function summaryLine(account: CalendarAccount): string | null {
  const summary = account.last_sync_summary as unknown as SyncSummary | null;
  if (!summary) return null;
  const parts = [
    `${summary.pushed} sent`,
    `${summary.pulled + summary.created} received`,
    summary.cancelled ? `${summary.cancelled} cancelled` : null,
    summary.deleted ? `${summary.deleted} removed` : null,
    summary.failed ? `${summary.failed} failed` : null
  ].filter(Boolean);
  return parts.join(' · ');
}

export function CalendarConnectionPanel({
  account,
  googleConfigured,
  tokenKeyConfigured,
  writable,
  syncAction,
  disconnectAction
}: {
  account: CalendarAccount | null;
  googleConfigured: boolean;
  tokenKeyConfigured: boolean;
  writable: boolean;
  syncAction: Action;
  disconnectAction: Action;
}) {
  // ---- not configured on this deployment ----------------------------------
  if (!googleConfigured || !tokenKeyConfigured) {
    return (
      <Card title="Google Calendar" className="mb-4">
        <Line>
          Not configured on this deployment, so appointments live in the CRM only.
        </Line>
        <ul className="mt-2 space-y-1 text-xs text-white/35">
          {!googleConfigured ? <li>· GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set.</li> : null}
          {!tokenKeyConfigured ? (
            <li>· CALENDAR_TOKEN_KEY is not set — OAuth tokens could not be stored safely.</li>
          ) : null}
        </ul>
        <p className="mt-2 text-xs text-white/35">See docs/agency-crm.md for the setup.</p>
      </Card>
    );
  }

  // ---- configured, nobody connected ---------------------------------------
  if (!account) {
    return (
      <Card title="Google Calendar" className="mb-4">
        <Line>
          Connect a Google account to book appointments into your real calendar, create Meet links,
          and see meetings booked elsewhere appear here.
        </Line>
        {writable ? (
          <a
            href="/api/crm/calendar/connect"
            className="mt-3 inline-block rounded-lg bg-electric-500 px-4 py-2 text-sm font-medium text-white hover:bg-electric-600"
          >
            Connect Google Calendar
          </a>
        ) : (
          <p className="mt-2 text-xs text-white/40">Your role is read-only.</p>
        )}
        <p className="mt-3 text-xs text-white/35">
          The CRM asks only for permission to manage calendar events. Attendees are never emailed
          unless you tick the box on the appointment.
        </p>
      </Card>
    );
  }

  // ---- connected -----------------------------------------------------------
  const broken = !account.is_active;
  const summary = summaryLine(account);

  return (
    <Card title="Google Calendar" className="mb-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={broken ? 'danger' : 'positive'}>
          {broken ? 'Needs reconnecting' : 'Connected'}
        </Badge>
        <span className="text-sm text-white/80">{account.google_email}</span>
        <span className="text-xs text-white/35">
          {account.calendar_id === 'primary' ? 'primary calendar' : account.calendar_id}
        </span>
      </div>

      <p className="mt-2 text-xs text-white/40">
        {account.last_synced_at
          ? `Last synced ${formatRelative(account.last_synced_at)}${summary ? ` — ${summary}` : ''}`
          : 'Not synced yet.'}
      </p>

      {account.last_error ? (
        <p className="mt-2 rounded-lg border border-amber-400/25 bg-amber-400/5 px-3 py-2 text-xs text-amber-200">
          {account.last_error}
        </p>
      ) : null}

      {writable ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {broken ? (
            <a
              href="/api/crm/calendar/connect"
              className="rounded-lg bg-electric-500 px-4 py-2 text-sm font-medium text-white hover:bg-electric-600"
            >
              Reconnect
            </a>
          ) : (
            <form action={syncAction}>
              <input type="hidden" name="account_id" value={account.id} />
              <SubmitButton tone="quiet">Sync now</SubmitButton>
            </form>
          )}

          <form action={disconnectAction}>
            <input type="hidden" name="account_id" value={account.id} />
            <SubmitButton tone="danger">Disconnect</SubmitButton>
          </form>
        </div>
      ) : null}

      <p className="mt-3 text-xs text-white/30">
        Disconnecting revokes this CRM&rsquo;s access at Google and deletes the stored tokens. Events
        already on your calendar stay there.
      </p>
    </Card>
  );
}

/** The sync state of one appointment, when there is anything to say. */
export function SyncBadge({
  state,
  error
}: {
  state: 'local' | 'pending' | 'synced' | 'failed';
  error?: string | null;
}) {
  if (state === 'local') return null;
  if (state === 'synced') return <Badge tone="positive">In Google</Badge>;
  if (state === 'pending') return <Badge tone="neutral">Syncing</Badge>;
  return <Badge tone="danger">{error ? `Sync failed: ${error}` : 'Sync failed'}</Badge>;
}

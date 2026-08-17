import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';

import { sealToken } from '../crypto';
import type { GoogleEvent } from '../googleCalendar';
import { APPOINTMENT_PROPERTY } from '../mapping';
import { drainDeletions, pullChanges, pushPending, syncAccount } from '../sync';
import { emptySummary, type CalendarAccount } from '../types';
import { ACCOUNT_ID, appointment, calendarAccount, FakeDb, FakeGoogle, PROFILE_ID } from './fakes';

process.env.CALENDAR_TOKEN_KEY = randomBytes(32).toString('base64');
process.env.GOOGLE_CLIENT_ID = 'client-id';
process.env.GOOGLE_CLIENT_SECRET = 'client-secret';
process.env.GOOGLE_REDIRECT_URI = 'https://crm.test/api/crm/calendar/callback';

/** Credentials that are still valid, so no refresh happens unless asked for. */
function liveCredentials(overrides: Record<string, unknown> = {}) {
  return {
    calendar_account_id: ACCOUNT_ID,
    access_token_enc: sealToken('live-access-token'),
    refresh_token_enc: sealToken('stored-refresh-token'),
    token_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    ...overrides
  };
}

function context(db: FakeDb, google: FakeGoogle, account = calendarAccount()) {
  return {
    service: db.client(),
    account: account as unknown as CalendarAccount,
    accessToken: 'live-access-token',
    transport: google.transport()
  };
}

describe('pushing local changes', () => {
  let db: FakeDb;
  let google: FakeGoogle;

  beforeEach(() => {
    google = new FakeGoogle();
    db = new FakeDb({
      calendar_accounts: [calendarAccount()],
      calendar_credentials: [liveCredentials()],
      appointments: [appointment()]
    });
  });

  it('creates the event and records what came back', async () => {
    const summary = emptySummary();
    await pushPending(context(db, google), summary);

    expect(summary.pushed).toBe(1);
    const row = db.find('appointments', 'appt-1')!;
    expect(row.sync_state).toBe('synced');
    expect(row.external_event_id).toBe('gcal-event-1');
    expect(row.external_html_link).toContain('calendar.google.com');
    expect(row.calendar_provider).toBe('google');
    expect(row.sync_error).toBeNull();
  });

  /**
   * The constraint that survives from the original brief: this CRM does not
   * contact anybody on its own. Google emails every attendee on write unless
   * told not to.
   */
  it('tells Google not to email anyone unless a human ticked the box', async () => {
    db.find('appointments', 'appt-1')!.attendee_emails = ['owner@practice.test'];
    await pushPending(context(db, google), emptySummary());

    const url = new URL(google.requestsTo('/events')[0].url);
    expect(url.searchParams.get('sendUpdates')).toBe('none');
  });

  it('emails attendees when, and only when, notify_attendees is set', async () => {
    db.find('appointments', 'appt-1')!.attendee_emails = ['owner@practice.test'];
    db.find('appointments', 'appt-1')!.notify_attendees = true;
    await pushPending(context(db, google), emptySummary());

    const url = new URL(google.requestsTo('/events')[0].url);
    expect(url.searchParams.get('sendUpdates')).toBe('all');
  });

  it('sets conferenceDataVersion when a Meet link is wanted, and gets one back', async () => {
    // Without the parameter Google accepts the request and silently creates no
    // conference, which looks exactly like success.
    db.find('appointments', 'appt-1')!.conference_requested = true;
    await pushPending(context(db, google), emptySummary());

    const url = new URL(google.requestsTo('/events')[0].url);
    expect(url.searchParams.get('conferenceDataVersion')).toBe('1');
    expect(db.find('appointments', 'appt-1')!.google_meet_url).toMatch(/meet\.google\.com/);
  });

  it('does not ask for a conference when none was wanted', async () => {
    await pushPending(context(db, google), emptySummary());
    const url = new URL(google.requestsTo('/events')[0].url);
    expect(url.searchParams.has('conferenceDataVersion')).toBe(false);
    expect(db.find('appointments', 'appt-1')!.google_meet_url).toBeNull();
  });

  it('patches an event that already exists instead of creating a second', async () => {
    Object.assign(db.find('appointments', 'appt-1')!, {
      external_event_id: 'gcal-existing',
      sync_state: 'pending'
    });
    await pushPending(context(db, google), emptySummary());

    const request = google.requestsTo('/events')[0];
    expect(request.method).toBe('PATCH');
    expect(request.url).toContain('gcal-existing');
  });

  it('records the failure on the row rather than losing it', async () => {
    const failing = new FakeGoogle({ writeStatus: 403, writeError: { error: { message: 'Quota exceeded' } } });
    const summary = emptySummary();
    await pushPending(context(db, failing), summary);

    expect(summary.failed).toBe(1);
    const row = db.find('appointments', 'appt-1')!;
    expect(row.sync_state).toBe('failed');
    expect(row.sync_error).toMatch(/Quota exceeded/);
  });

  it('stops the whole run on an auth failure instead of marking every row broken', async () => {
    db.rows('appointments').push(appointment({ id: 'appt-2' }));
    const revoked = new FakeGoogle({
      writeStatus: 401,
      writeError: { error: { message: 'Invalid Credentials' } }
    });

    await expect(pushPending(context(db, revoked), emptySummary())).rejects.toThrow();
    // The second appointment was never touched, so it is still pushable once
    // the connection is fixed.
    expect(db.find('appointments', 'appt-2')!.sync_state).toBe('pending');
  });

  it('only pushes this account’s appointments', async () => {
    db.rows('appointments').push(
      appointment({ id: 'someone-else', calendar_account_id: 'other-account' })
    );
    await pushPending(context(db, google), emptySummary());
    expect(db.find('appointments', 'someone-else')!.sync_state).toBe('pending');
  });
});

describe('pulling remote changes', () => {
  function remoteEvent(overrides: Partial<GoogleEvent> = {}): GoogleEvent {
    return {
      id: 'gcal-remote-1',
      summary: 'Booked from Google',
      status: 'confirmed',
      start: { dateTime: '2026-09-05T10:00:00+01:00', timeZone: 'Europe/London' },
      end: { dateTime: '2026-09-05T11:00:00+01:00', timeZone: 'Europe/London' },
      updated: '2026-08-18T09:00:00.000Z',
      htmlLink: 'https://calendar.google.com/event?eid=remote',
      ...overrides
    };
  }

  it('imports an event created in Google', async () => {
    const db = new FakeDb({ calendar_accounts: [calendarAccount()], appointments: [] });
    const google = new FakeGoogle({ pages: [{ items: [remoteEvent()] }] });

    const summary = emptySummary();
    await pullChanges(context(db, google), summary);

    expect(summary.created).toBe(1);
    const [row] = db.rows('appointments');
    expect(row.title).toBe('Booked from Google');
    expect(row.starts_at).toBe('2026-09-05T09:00:00.000Z');
    expect(row.created_by).toBe(PROFILE_ID);
    expect(row.sync_state).toBe('synced');
  });

  it('does not import the same event twice', async () => {
    const db = new FakeDb({
      calendar_accounts: [calendarAccount()],
      appointments: [
        appointment({
          id: 'appt-existing',
          calendar_provider: 'google',
          external_event_id: 'gcal-remote-1',
          sync_state: 'synced',
          updated_at: '2026-08-19T00:00:00.000Z'
        })
      ]
    });
    const google = new FakeGoogle({ pages: [{ items: [remoteEvent()] }] });

    const summary = emptySummary();
    await pullChanges(context(db, google), summary);

    expect(db.rows('appointments')).toHaveLength(1);
    expect(summary.created).toBe(0);
  });

  it('applies a remote edit that is newer than the local row', async () => {
    const db = new FakeDb({
      calendar_accounts: [calendarAccount()],
      appointments: [
        appointment({
          id: 'appt-existing',
          title: 'Old title',
          calendar_provider: 'google',
          external_event_id: 'gcal-remote-1',
          sync_state: 'synced',
          updated_at: '2026-08-17T00:00:00.000Z'
        })
      ]
    });
    const google = new FakeGoogle({ pages: [{ items: [remoteEvent({ summary: 'Moved by the client' })] }] });

    const summary = emptySummary();
    await pullChanges(context(db, google), summary);

    expect(summary.pulled).toBe(1);
    expect(db.find('appointments', 'appt-existing')!.title).toBe('Moved by the client');
  });

  it('leaves an unpushed local edit alone, because it is about to go out', async () => {
    const db = new FakeDb({
      calendar_accounts: [calendarAccount()],
      appointments: [
        appointment({
          id: 'appt-existing',
          title: 'Edited here, not yet sent',
          calendar_provider: 'google',
          external_event_id: 'gcal-remote-1',
          sync_state: 'pending',
          updated_at: '2026-08-01T00:00:00.000Z'
        })
      ]
    });
    const google = new FakeGoogle({ pages: [{ items: [remoteEvent({ summary: 'Remote wins?' })] }] });

    await pullChanges(context(db, google), emptySummary());
    expect(db.find('appointments', 'appt-existing')!.title).toBe('Edited here, not yet sent');
  });

  it('honours a cancellation whatever the timestamps say', async () => {
    // An event deleted in Google is not coming back. Leaving it live in the
    // CRM sends somebody to a meeting that is not happening.
    const db = new FakeDb({
      calendar_accounts: [calendarAccount()],
      appointments: [
        appointment({
          id: 'appt-existing',
          status: 'confirmed',
          calendar_provider: 'google',
          external_event_id: 'gcal-remote-1',
          sync_state: 'synced',
          updated_at: '2030-01-01T00:00:00.000Z'
        })
      ]
    });
    const google = new FakeGoogle({
      pages: [{ items: [{ id: 'gcal-remote-1', status: 'cancelled', updated: '2026-08-18T09:00:00Z' }] }]
    });

    const summary = emptySummary();
    await pullChanges(context(db, google), summary);

    expect(summary.cancelled).toBe(1);
    expect(db.find('appointments', 'appt-existing')!.status).toBe('cancelled');
  });

  it('ignores a tombstone for an event it never had', async () => {
    const db = new FakeDb({ calendar_accounts: [calendarAccount()], appointments: [] });
    const google = new FakeGoogle({
      pages: [{ items: [{ id: 'never-seen', status: 'cancelled', updated: '2026-08-18T09:00:00Z' }] }]
    });

    await pullChanges(context(db, google), emptySummary());
    expect(db.rows('appointments')).toHaveLength(0);
  });

  it('matches on the stamped appointment id, not the event id', async () => {
    // Recovers the case where a push created the event but the write-back
    // failed: the CRM row has no external_event_id, but the event knows.
    const db = new FakeDb({
      calendar_accounts: [calendarAccount()],
      appointments: [
        appointment({ id: 'appt-orphan', external_event_id: null, sync_state: 'synced' })
      ]
    });
    const google = new FakeGoogle({
      pages: [
        {
          items: [
            remoteEvent({
              extendedProperties: { private: { [APPOINTMENT_PROPERTY]: 'appt-orphan' } }
            })
          ]
        }
      ]
    });

    await pullChanges(context(db, google), emptySummary());

    expect(db.rows('appointments')).toHaveLength(1);
    expect(db.find('appointments', 'appt-orphan')!.external_event_id).toBe('gcal-remote-1');
  });

  it('sends the sync token, and no timeMin alongside it', async () => {
    // Google rejects both together with a 400.
    const db = new FakeDb({ calendar_accounts: [calendarAccount()], appointments: [] });
    const google = new FakeGoogle({ pages: [{ items: [] }] });

    await pullChanges(context(db, google), emptySummary());

    const url = new URL(google.requestsTo('/events')[0].url);
    expect(url.searchParams.get('syncToken')).toBe('sync-token-current');
    expect(url.searchParams.has('timeMin')).toBe(false);
    expect(url.searchParams.get('showDeleted')).toBe('true');
  });

  it('falls back to a full window when Google expires the cursor', async () => {
    // The 410 path. Without it a calendar quietly stops updating and nothing
    // says so.
    const db = new FakeDb({ calendar_accounts: [calendarAccount()], appointments: [] });
    const google = new FakeGoogle({
      expireSyncToken: true,
      pages: [{ items: [] }, { items: [remoteEvent()] }]
    });

    const summary = emptySummary();
    await pullChanges(context(db, google), summary);

    expect(summary.fullResync).toBe(true);
    expect(summary.created).toBe(1);
    const retry = new URL(google.requestsTo('/events')[1].url);
    expect(retry.searchParams.has('syncToken')).toBe(false);
    expect(retry.searchParams.has('timeMin')).toBe(true);
  });

  it('follows pagination and keeps the final sync token', async () => {
    const db = new FakeDb({ calendar_accounts: [calendarAccount()], appointments: [] });
    const google = new FakeGoogle({
      pages: [
        { items: [remoteEvent({ id: 'a' })], nextPageToken: 'page-2' },
        { items: [remoteEvent({ id: 'b' })], nextSyncToken: 'final-token' }
      ]
    });

    const token = await pullChanges(context(db, google), emptySummary());
    expect(db.rows('appointments')).toHaveLength(2);
    expect(token).toBe('final-token');
  });
});

describe('deletions', () => {
  it('removes the event and clears the outbox row', async () => {
    const db = new FakeDb({
      calendar_accounts: [calendarAccount()],
      calendar_deletions: [
        {
          id: 'del-1',
          calendar_account_id: ACCOUNT_ID,
          calendar_id: 'primary',
          external_event_id: 'gcal-gone',
          attempts: 0,
          last_error: null
        }
      ]
    });
    const google = new FakeGoogle();

    const summary = emptySummary();
    await drainDeletions(context(db, google), summary);

    expect(summary.deleted).toBe(1);
    expect(db.rows('calendar_deletions')).toHaveLength(0);
    expect(google.lastRequest.method).toBe('DELETE');
    expect(new URL(google.lastRequest.url).searchParams.get('sendUpdates')).toBe('none');
  });
});

describe('a whole run', () => {
  it('pushes, pulls and records the outcome on the account', async () => {
    const db = new FakeDb({
      calendar_accounts: [calendarAccount()],
      calendar_credentials: [liveCredentials()],
      appointments: [appointment()]
    });
    const google = new FakeGoogle({
      pages: [{ items: [], nextSyncToken: 'token-after-run' }]
    });

    const summary = await syncAccount(
      db.client(),
      calendarAccount() as unknown as CalendarAccount,
      { transport: google.transport() }
    );

    expect(summary.pushed).toBe(1);
    const account = db.rows('calendar_accounts')[0];
    expect(account.sync_token).toBe('token-after-run');
    expect(account.last_synced_at).toBeTruthy();
    expect(account.last_error).toBeNull();
  });

  it('refreshes an expired access token and stores the new one', async () => {
    const db = new FakeDb({
      calendar_accounts: [calendarAccount()],
      calendar_credentials: [
        liveCredentials({ token_expires_at: new Date(Date.now() - 1000).toISOString() })
      ],
      appointments: []
    });
    const google = new FakeGoogle({ pages: [{ items: [] }] });

    await syncAccount(db.client(), calendarAccount() as unknown as CalendarAccount, {
      transport: google.transport()
    });

    expect(google.requestsTo('/token')).toHaveLength(1);
    const stored = db.rows('calendar_credentials')[0];
    // The refresh token is kept: Google does not repeat it, and overwriting it
    // with null is how a connection dies an hour after it is made.
    expect(stored.refresh_token_enc).toBeTruthy();
    expect(stored.token_expires_at).not.toBe(null);
  });

  it('records the failure instead of throwing at the caller', async () => {
    // A calendar that has silently not synced for a fortnight looks exactly
    // like a calendar with nothing in it.
    const db = new FakeDb({
      calendar_accounts: [calendarAccount()],
      calendar_credentials: [],
      appointments: []
    });

    const summary = await syncAccount(
      db.client(),
      calendarAccount() as unknown as CalendarAccount,
      { transport: new FakeGoogle().transport() }
    );

    expect(summary.errors[0]).toMatch(/Reconnect the calendar/);
    expect(db.rows('calendar_accounts')[0].last_error).toMatch(/Reconnect the calendar/);
  });

  it('does nothing at all for a disconnected account', async () => {
    const db = new FakeDb({ calendar_accounts: [calendarAccount({ is_active: false })] });
    const google = new FakeGoogle();

    const summary = await syncAccount(
      db.client(),
      calendarAccount({ is_active: false }) as unknown as CalendarAccount,
      { transport: google.transport() }
    );

    expect(google.requests).toHaveLength(0);
    expect(summary.errors[0]).toMatch(/not active/);
  });
});

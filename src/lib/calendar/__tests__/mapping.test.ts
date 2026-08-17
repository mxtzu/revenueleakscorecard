import { describe, expect, it } from 'vitest';

import type { Appointment, AppointmentStatus } from '@/lib/crm/types';
import { conferenceUrl, type GoogleEvent } from '../googleCalendar';
import {
  APPOINTMENT_PROPERTY,
  appointmentIdOf,
  appointmentToEvent,
  crmStatusFor,
  DEFAULT_DURATION_MINUTES,
  eventToAppointment,
  googleStatusFor,
  pushResultOf,
  remoteIsNewer
} from '../mapping';
import { appointment as appointmentRow } from './fakes';

function appt(overrides: Partial<Appointment> = {}): Appointment {
  return { ...(appointmentRow() as unknown as Appointment), ...overrides };
}

describe('CRM appointment to Google event', () => {
  it('sends an explicit time zone, not just an instant', () => {
    // Google renders an event in the zone it was created in. A 14:00 London
    // call sent as a bare UTC instant is an hour out for half the year.
    const { event } = appointmentToEvent(appt({ timezone: 'Europe/London' }));
    expect(event.start?.timeZone).toBe('Europe/London');
    expect(event.end?.timeZone).toBe('Europe/London');
  });

  it('gives an open-ended appointment a default length', () => {
    const { event } = appointmentToEvent(
      appt({ starts_at: '2026-09-01T09:00:00.000Z', ends_at: null })
    );
    const minutes =
      (new Date(event.end!.dateTime!).getTime() - new Date(event.start!.dateTime!).getTime()) /
      60_000;
    expect(minutes).toBe(DEFAULT_DURATION_MINUTES);
  });

  it('stamps the appointment id onto the event', () => {
    // Two calls booked back to back are indistinguishable by title and time.
    const { event } = appointmentToEvent(appt({ id: 'appt-42' }));
    expect(event.extendedProperties?.private?.[APPOINTMENT_PROPERTY]).toBe('appt-42');
    expect(appointmentIdOf(event)).toBe('appt-42');
  });

  it('requests a Meet link only when one is wanted and none exists', () => {
    const wanted = appointmentToEvent(appt({ conference_requested: true, google_meet_url: null }));
    expect(wanted.withConference).toBe(true);
    expect(wanted.event.conferenceData?.createRequest?.conferenceSolutionKey.type).toBe(
      'hangoutsMeet'
    );

    // Re-requesting on every edit would mint a new link and break the one that
    // is already in everybody's invitation.
    const already = appointmentToEvent(
      appt({ conference_requested: true, google_meet_url: 'https://meet.google.com/abc-defg-hij' })
    );
    expect(already.withConference).toBe(false);
    expect(already.event.conferenceData).toBeUndefined();

    const never = appointmentToEvent(appt({ conference_requested: false }));
    expect(never.withConference).toBe(false);
  });

  it('uses a stable conference request id, so a retry does not make two links', () => {
    const first = appointmentToEvent(appt({ id: 'appt-7', conference_requested: true }));
    const retry = appointmentToEvent(appt({ id: 'appt-7', conference_requested: true }));
    expect(first.event.conferenceData?.createRequest?.requestId).toBe(
      retry.event.conferenceData?.createRequest?.requestId
    );
  });

  it('omits attendees entirely when there are none', () => {
    // An empty array is not the same as no key: Google reads `attendees: []`
    // on a patch as "remove everyone".
    const { event } = appointmentToEvent(appt({ attendee_emails: [] }));
    expect(event.attendees).toBeUndefined();
    const withPeople = appointmentToEvent(appt({ attendee_emails: ['a@b.test'] }));
    expect(withPeople.event.attendees).toEqual([{ email: 'a@b.test' }]);
  });
});

describe('status mapping', () => {
  it('collapses six CRM statuses into Google’s three', () => {
    const expected: Record<AppointmentStatus, string> = {
      scheduled: 'tentative',
      confirmed: 'confirmed',
      completed: 'confirmed',
      no_show: 'confirmed',
      cancelled: 'cancelled',
      rescheduled: 'cancelled'
    };
    for (const [crm, google] of Object.entries(expected)) {
      expect(googleStatusFor(crm as AppointmentStatus)).toBe(google);
    }
  });

  it('keeps a completed meeting on the calendar', () => {
    // It did occupy that slot. Removing it after the fact rewrites everyone's
    // diary for a week that already happened.
    expect(googleStatusFor('completed')).toBe('confirmed');
    expect(googleStatusFor('no_show')).toBe('confirmed');
  });

  it('reads Google’s status back', () => {
    expect(crmStatusFor({ status: 'cancelled' })).toBe('cancelled');
    expect(crmStatusFor({ status: 'tentative' })).toBe('scheduled');
    expect(crmStatusFor({ status: 'confirmed' })).toBe('confirmed');
    expect(crmStatusFor({})).toBe('confirmed');
  });
});

describe('Google event to CRM appointment', () => {
  const base: GoogleEvent = {
    id: 'evt-1',
    summary: 'Intro call',
    status: 'confirmed',
    start: { dateTime: '2026-09-01T10:00:00+01:00', timeZone: 'Europe/London' },
    end: { dateTime: '2026-09-01T10:45:00+01:00', timeZone: 'Europe/London' },
    updated: '2026-08-17T12:00:00.000Z',
    htmlLink: 'https://calendar.google.com/event?eid=x'
  };

  it('normalises times to UTC and keeps the zone', () => {
    const pulled = eventToAppointment(base, 'UTC')!;
    expect(pulled.starts_at).toBe('2026-09-01T09:00:00.000Z');
    expect(pulled.timezone).toBe('Europe/London');
  });

  it('skips all-day entries rather than importing them as midnight', () => {
    // "Annual leave" is not a 00:00 appointment, and importing it as one puts
    // a meeting that does not exist at the top of somebody's day.
    expect(eventToAppointment({ ...base, start: { date: '2026-09-01' }, end: { date: '2026-09-02' } }, 'UTC'))
      .toBeNull();
  });

  it('skips an event with no id', () => {
    expect(eventToAppointment({ ...base, id: undefined }, 'UTC')).toBeNull();
  });

  it('reports a cancellation tombstone even though it carries no times', () => {
    // Incremental sync delivers deletions as near-empty items; requiring a
    // start time would silently drop every cancellation.
    const pulled = eventToAppointment(
      { id: 'evt-1', status: 'cancelled', updated: '2026-08-18T09:00:00.000Z' },
      'Europe/London'
    )!;
    expect(pulled.cancelled).toBe(true);
    expect(pulled.external_event_id).toBe('evt-1');
  });

  it('falls back to the account zone when the event does not state one', () => {
    const pulled = eventToAppointment(
      { ...base, start: { dateTime: '2026-09-01T10:00:00Z' } },
      'Europe/London'
    )!;
    expect(pulled.timezone).toBe('Europe/London');
  });

  it('names an untitled event rather than storing a blank', () => {
    expect(eventToAppointment({ ...base, summary: '   ' }, 'UTC')!.title).toBe('Untitled event');
  });

  it('finds the Meet link from either shape Google uses', () => {
    expect(conferenceUrl({ hangoutLink: 'https://meet.google.com/a' })).toBe(
      'https://meet.google.com/a'
    );
    expect(
      conferenceUrl({
        conferenceData: { entryPoints: [{ entryPointType: 'video', uri: 'https://meet.google.com/b' }] }
      })
    ).toBe('https://meet.google.com/b');
    expect(
      conferenceUrl({
        conferenceData: { entryPoints: [{ entryPointType: 'phone', uri: 'tel:+441234' }] }
      })
    ).toBeNull();
  });
});

describe('writing the push result back', () => {
  it('keeps an existing Meet link when the response does not repeat it', () => {
    // A patch without conferenceDataVersion omits conferenceData. Reading that
    // as "the link was removed" would wipe a working one.
    const result = pushResultOf({ id: 'evt-1' }, 'https://meet.google.com/kept');
    expect(result.google_meet_url).toBe('https://meet.google.com/kept');
  });

  it('takes the new link when Google sends one', () => {
    const result = pushResultOf({ id: 'evt-1', hangoutLink: 'https://meet.google.com/new' }, null);
    expect(result.google_meet_url).toBe('https://meet.google.com/new');
  });
});

describe('conflict resolution', () => {
  it('prefers the remote copy only when it really is newer', () => {
    expect(remoteIsNewer('2026-08-18T10:00:00Z', '2026-08-17T10:00:00Z')).toBe(true);
    expect(remoteIsNewer('2026-08-16T10:00:00Z', '2026-08-17T10:00:00Z')).toBe(false);
  });

  it('gives ties to the CRM', () => {
    const same = '2026-08-17T10:00:00Z';
    expect(remoteIsNewer(same, same)).toBe(false);
  });

  it('never overwrites on a missing remote timestamp', () => {
    expect(remoteIsNewer(null, '2026-08-17T10:00:00Z')).toBe(false);
  });
});

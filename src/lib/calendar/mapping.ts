/**
 * Translating between a CRM appointment and a Google event.
 *
 * Pure functions, no I/O, because this is where a two-way sync actually goes
 * wrong — a status mapped in one direction but not the other, a timezone
 * dropped, an all-day event read as midnight local. Keeping it pure means all
 * of that is testable without a Google account.
 */

import { conferenceUrl, meetRequest, type GoogleEvent } from './googleCalendar';
import type { Appointment, AppointmentStatus } from '@/lib/crm/types';

/** How long an appointment runs when nobody said. */
export const DEFAULT_DURATION_MINUTES = 30;

/**
 * Marks an event as ours.
 *
 * Written into Google's `extendedProperties.private`, which is invisible in the
 * UI and returned on every read. It is what lets the pull decide "this is the
 * event I created for appointment X" instead of matching on title and time and
 * getting it wrong for two calls booked back to back.
 */
export const APPOINTMENT_PROPERTY = 'crmAppointmentId';

export function appointmentIdOf(event: GoogleEvent): string | null {
  return event.extendedProperties?.private?.[APPOINTMENT_PROPERTY] ?? null;
}

function endOf(appointment: Pick<Appointment, 'starts_at' | 'ends_at'>): string {
  if (appointment.ends_at) return appointment.ends_at;
  const start = new Date(appointment.starts_at);
  return new Date(start.getTime() + DEFAULT_DURATION_MINUTES * 60_000).toISOString();
}

/**
 * CRM status → Google status.
 *
 * Google has three: confirmed, tentative, cancelled. The CRM's six all collapse
 * into those. `completed` and `no_show` stay confirmed on purpose — the meeting
 * did occupy that slot, and rewriting history to remove it would take it out of
 * everyone's calendar after the fact.
 */
export function googleStatusFor(status: AppointmentStatus): 'confirmed' | 'tentative' | 'cancelled' {
  switch (status) {
    case 'cancelled':
    case 'rescheduled':
      return 'cancelled';
    case 'scheduled':
      return 'tentative';
    default:
      return 'confirmed';
  }
}

/**
 * Google status → CRM status.
 *
 * Only used for events that came from Google, and only to set an initial
 * value. A cancellation is the one signal worth importing; everything else the
 * CRM knows better, so an existing appointment's status is not overwritten by
 * a pull.
 */
export function crmStatusFor(event: GoogleEvent): AppointmentStatus {
  if (event.status === 'cancelled') return 'cancelled';
  if (event.status === 'tentative') return 'scheduled';
  return 'confirmed';
}

export interface EventDraft {
  event: GoogleEvent;
  withConference: boolean;
}

/**
 * Build the event to send.
 *
 * `dateTime` plus an explicit `timeZone` rather than a bare UTC instant:
 * Google shows a recurring or moved event in the zone it was created in, and a
 * 14:00 call in London that reads as 14:00Z is an hour out for half the year.
 *
 * A conference is only requested when one has not already been minted. Sending
 * a fresh `createRequest` on every update would ask Google for a new Meet link
 * each time and invalidate the one already in the invitation.
 */
export function appointmentToEvent(
  appointment: Pick<
    Appointment,
    | 'id'
    | 'title'
    | 'starts_at'
    | 'ends_at'
    | 'timezone'
    | 'status'
    | 'attendee_emails'
    | 'conference_requested'
    | 'google_meet_url'
    | 'meeting_notes'
  >
): EventDraft {
  const needsConference = appointment.conference_requested && !appointment.google_meet_url;

  const event: GoogleEvent = {
    summary: appointment.title,
    status: googleStatusFor(appointment.status),
    start: { dateTime: appointment.starts_at, timeZone: appointment.timezone },
    end: { dateTime: endOf(appointment), timeZone: appointment.timezone },
    extendedProperties: { private: { [APPOINTMENT_PROPERTY]: appointment.id } }
  };

  if (appointment.attendee_emails.length > 0) {
    event.attendees = appointment.attendee_emails.map((email) => ({ email }));
  }
  if (needsConference) {
    // Idempotency key: Google returns the same conference if the same request
    // id is replayed, so a retried push does not mint a second Meet link.
    event.conferenceData = meetRequest(`crm-${appointment.id}`);
  }

  return { event, withConference: needsConference };
}

/** What a successful push writes back onto the appointment row. */
export interface PushResult {
  external_event_id: string | null;
  external_html_link: string | null;
  external_updated_at: string | null;
  google_meet_url: string | null;
  calendar_provider: string;
}

export function pushResultOf(event: GoogleEvent, existingMeetUrl: string | null): PushResult {
  return {
    external_event_id: event.id ?? null,
    external_html_link: event.htmlLink ?? null,
    external_updated_at: event.updated ?? null,
    // Keep the link we already had if this response did not carry one: a patch
    // without conferenceDataVersion omits conferenceData entirely, and reading
    // that as "the Meet link was removed" would wipe a working link.
    google_meet_url: conferenceUrl(event) ?? existingMeetUrl,
    calendar_provider: 'google'
  };
}

/** Fields a pull writes onto an appointment that came from, or lives in, Google. */
export interface PulledEvent {
  external_event_id: string;
  title: string;
  starts_at: string;
  ends_at: string | null;
  timezone: string;
  google_meet_url: string | null;
  external_html_link: string | null;
  external_updated_at: string | null;
  attendee_emails: string[];
  cancelled: boolean;
}

/**
 * Read a Google event into CRM fields.
 *
 * Returns null for anything unusable: an event with no id, or an all-day event.
 * All-day entries are skipped deliberately rather than imported as midnight —
 * "annual leave" is not a 00:00 appointment, and importing it as one puts a
 * fake meeting at the top of somebody's day.
 */
export function eventToAppointment(
  event: GoogleEvent,
  fallbackTimezone: string
): PulledEvent | null {
  if (!event.id) return null;

  const cancelled = event.status === 'cancelled';
  const startsAt = event.start?.dateTime;

  // A cancellation arrives as a tombstone with almost nothing on it, so it is
  // reported without requiring times; anything else needs a real start.
  if (!startsAt) {
    if (!cancelled) return null;
    return {
      external_event_id: event.id,
      title: event.summary ?? 'Untitled',
      starts_at: '',
      ends_at: null,
      timezone: fallbackTimezone,
      google_meet_url: null,
      external_html_link: null,
      external_updated_at: event.updated ?? null,
      attendee_emails: [],
      cancelled: true
    };
  }

  return {
    external_event_id: event.id,
    title: event.summary?.trim() || 'Untitled event',
    starts_at: new Date(startsAt).toISOString(),
    ends_at: event.end?.dateTime ? new Date(event.end.dateTime).toISOString() : null,
    timezone: event.start?.timeZone ?? fallbackTimezone,
    google_meet_url: conferenceUrl(event),
    external_html_link: event.htmlLink ?? null,
    external_updated_at: event.updated ?? null,
    attendee_emails: (event.attendees ?? [])
      .map((attendee) => attendee.email)
      .filter((email): email is string => Boolean(email)),
    cancelled
  };
}

/**
 * Which side changed last.
 *
 * Both systems can be edited independently, so a two-way sync needs a rule, and
 * an explicit one beats whichever request happened to arrive second. Google's
 * `updated` is compared against the CRM's `updated_at`; ties go to the CRM,
 * because the CRM is where the appointment was created and where its context
 * lives.
 */
export function remoteIsNewer(
  remoteUpdated: string | null,
  localUpdated: string | null
): boolean {
  if (!remoteUpdated) return false;
  if (!localUpdated) return true;
  return new Date(remoteUpdated).getTime() > new Date(localUpdated).getTime();
}

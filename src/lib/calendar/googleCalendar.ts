/**
 * The Google Calendar v3 calls this CRM makes, and no others.
 *
 * Two details are load-bearing:
 *
 *   sendUpdates — defaults to `none` everywhere. Writing an event with an
 *   attendee makes Google email that attendee, and this CRM does not contact
 *   people on its own. Nothing sends unless a human ticked the box, and the
 *   parameter is required on every call site rather than defaulted somewhere
 *   deep, so it cannot be forgotten.
 *
 *   syncToken — the incremental cursor. Listing without one pulls the whole
 *   calendar; Google expires them, answering 410, and the only correct
 *   response is to throw the cursor away and resync in full. That path is
 *   handled here and tested, because it is the one that gets discovered in
 *   production otherwise.
 */

import { defaultTransport, GoogleApiError, query, readJson, type Transport } from './http';

const API = 'https://www.googleapis.com/calendar/v3';

/** Whether Google should email attendees about this write. */
export type SendUpdates = 'none' | 'all' | 'externalOnly';

export interface GoogleEventTime {
  dateTime?: string;
  date?: string;
  timeZone?: string;
}

export interface GoogleEvent {
  id?: string;
  status?: 'confirmed' | 'tentative' | 'cancelled';
  summary?: string;
  description?: string;
  location?: string;
  start?: GoogleEventTime;
  end?: GoogleEventTime;
  attendees?: { email: string; responseStatus?: string; organizer?: boolean }[];
  conferenceData?: {
    createRequest?: { requestId: string; conferenceSolutionKey: { type: string } };
    entryPoints?: { entryPointType?: string; uri?: string }[];
    conferenceId?: string;
  };
  hangoutLink?: string;
  htmlLink?: string;
  updated?: string;
  etag?: string;
  extendedProperties?: { private?: Record<string, string> };
}

export interface EventListPage {
  items: GoogleEvent[];
  nextPageToken: string | null;
  nextSyncToken: string | null;
}

export interface CalendarRequestContext {
  accessToken: string;
  calendarId: string;
  transport?: Transport;
}

function authorised(ctx: CalendarRequestContext) {
  return {
    transport: ctx.transport ?? defaultTransport(),
    headers: {
      authorization: `Bearer ${ctx.accessToken}`,
      'content-type': 'application/json'
    }
  };
}

function path(calendarId: string, suffix = ''): string {
  return `${API}/calendars/${encodeURIComponent(calendarId)}/events${suffix}`;
}

/**
 * A Meet link is requested, not set.
 *
 * You cannot write `hangoutLink` — Google mints the conference asynchronously
 * from a `createRequest`, and `conferenceDataVersion=1` is what tells the API
 * to honour it at all. Without that parameter the request is silently accepted
 * and no conference is created, which looks exactly like it worked.
 */
export function meetRequest(requestId: string): NonNullable<GoogleEvent['conferenceData']> {
  return {
    createRequest: { requestId, conferenceSolutionKey: { type: 'hangoutsMeet' } }
  };
}

/** The Meet (or other conference) URL on an event Google has returned. */
export function conferenceUrl(event: GoogleEvent): string | null {
  if (event.hangoutLink) return event.hangoutLink;
  const entry = event.conferenceData?.entryPoints?.find(
    (point) => point.entryPointType === 'video' && point.uri
  );
  return entry?.uri ?? null;
}

export async function insertEvent(
  ctx: CalendarRequestContext,
  event: GoogleEvent,
  options: { sendUpdates: SendUpdates; withConference: boolean }
): Promise<GoogleEvent> {
  const { transport, headers } = authorised(ctx);
  const response = await transport({
    method: 'POST',
    url:
      path(ctx.calendarId) +
      query({
        sendUpdates: options.sendUpdates,
        conferenceDataVersion: options.withConference ? 1 : undefined
      }),
    headers,
    body: JSON.stringify(event)
  });
  return readJson<GoogleEvent>(response, 'Could not create the calendar event');
}

export async function patchEvent(
  ctx: CalendarRequestContext,
  eventId: string,
  event: GoogleEvent,
  options: { sendUpdates: SendUpdates; withConference: boolean }
): Promise<GoogleEvent> {
  const { transport, headers } = authorised(ctx);
  const response = await transport({
    method: 'PATCH',
    url:
      path(ctx.calendarId, `/${encodeURIComponent(eventId)}`) +
      query({
        sendUpdates: options.sendUpdates,
        conferenceDataVersion: options.withConference ? 1 : undefined
      }),
    headers,
    body: JSON.stringify(event)
  });
  return readJson<GoogleEvent>(response, 'Could not update the calendar event');
}

/**
 * Deleting an event that is already gone is success, not failure.
 *
 * 404 and 410 both mean "not on the calendar", which is the state the caller
 * wanted. Treating them as errors would make the deletion outbox retry forever.
 */
export async function deleteEvent(
  ctx: CalendarRequestContext,
  eventId: string,
  options: { sendUpdates: SendUpdates }
): Promise<void> {
  const { transport, headers } = authorised(ctx);
  const response = await transport({
    method: 'DELETE',
    url:
      path(ctx.calendarId, `/${encodeURIComponent(eventId)}`) +
      query({ sendUpdates: options.sendUpdates }),
    headers
  });
  if (response.status === 404 || response.status === 410) return;
  if (response.status >= 400) readJson(response, 'Could not delete the calendar event');
}

export async function getEvent(
  ctx: CalendarRequestContext,
  eventId: string
): Promise<GoogleEvent | null> {
  const { transport, headers } = authorised(ctx);
  const response = await transport({
    method: 'GET',
    url: path(ctx.calendarId, `/${encodeURIComponent(eventId)}`),
    headers
  });
  if (response.status === 404 || response.status === 410) return null;
  return readJson<GoogleEvent>(response, 'Could not read the calendar event');
}

/**
 * One page of changes.
 *
 * With `syncToken`, Google returns only what changed since it was issued —
 * including cancellations, as items with `status: 'cancelled'`. Without one it
 * returns everything from `timeMin` forward, and that first pass is what mints
 * the token for next time.
 *
 * `showDeleted` is on with a sync token because a deletion is a change we need
 * to see; a full pull wants live events only.
 */
export async function listEvents(
  ctx: CalendarRequestContext,
  options: { syncToken?: string | null; pageToken?: string | null; timeMin?: string; maxResults?: number }
): Promise<EventListPage> {
  const { transport, headers } = authorised(ctx);
  const incremental = Boolean(options.syncToken);

  const response = await transport({
    method: 'GET',
    url:
      path(ctx.calendarId) +
      query({
        syncToken: options.syncToken ?? undefined,
        pageToken: options.pageToken ?? undefined,
        // timeMin and syncToken are mutually exclusive; sending both is a 400.
        timeMin: incremental ? undefined : options.timeMin,
        showDeleted: incremental ? 'true' : 'false',
        singleEvents: 'true',
        maxResults: options.maxResults ?? 250
      }),
    headers
  });

  const payload = readJson<{
    items?: GoogleEvent[];
    nextPageToken?: string;
    nextSyncToken?: string;
  }>(response, 'Could not read the calendar');

  return {
    items: payload.items ?? [],
    nextPageToken: payload.nextPageToken ?? null,
    nextSyncToken: payload.nextSyncToken ?? null
  };
}

/**
 * Ask Google to notify a URL when this calendar changes.
 *
 * Optional: the sync works by polling without it. A channel just makes the
 * poll happen promptly instead of on a schedule, and Google expires channels
 * within a week, so nothing may depend on one existing.
 */
export async function watchCalendar(
  ctx: CalendarRequestContext,
  options: { channelId: string; address: string; token: string; ttlSeconds?: number }
): Promise<{ resourceId: string | null; expiration: string | null }> {
  const { transport, headers } = authorised(ctx);
  const response = await transport({
    method: 'POST',
    url: path(ctx.calendarId, '/watch'),
    headers,
    body: JSON.stringify({
      id: options.channelId,
      type: 'web_hook',
      address: options.address,
      // Echoed back on every notification, and the only thing that
      // distinguishes a real callback from anyone who guessed the URL.
      token: options.token,
      params: options.ttlSeconds ? { ttl: String(options.ttlSeconds) } : undefined
    })
  });

  const payload = readJson<{ resourceId?: string; expiration?: string }>(
    response,
    'Could not subscribe to calendar changes'
  );
  return {
    resourceId: payload.resourceId ?? null,
    // Google reports expiration as epoch milliseconds, as a string.
    expiration: payload.expiration
      ? new Date(Number(payload.expiration)).toISOString()
      : null
  };
}

export async function stopChannel(
  ctx: CalendarRequestContext,
  options: { channelId: string; resourceId: string }
): Promise<void> {
  const { transport, headers } = authorised(ctx);
  const response = await transport({
    method: 'POST',
    url: `${API}/channels/stop`,
    headers,
    body: JSON.stringify({ id: options.channelId, resourceId: options.resourceId })
  });
  if (response.status === 404) return;
  if (response.status >= 400) readJson(response, 'Could not stop the calendar channel');
}

export { GoogleApiError };

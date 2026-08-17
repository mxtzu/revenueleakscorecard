/**
 * The one place this codebase talks to Google.
 *
 * Every request goes through an injectable `Transport` rather than calling
 * `fetch` directly. That is not ceremony: it is what makes the OAuth exchange,
 * the token refresh, the incremental sync cursor and the 410-resync path
 * testable at all. A test supplies a transport that returns canned responses
 * and asserts the exact request that was built — the URL, the query string, the
 * body, the `sendUpdates` parameter — which is the half of the integration this
 * code is responsible for.
 *
 * It also means the whole calendar feature can be developed and verified with
 * no outbound network, which is how it was.
 */

export interface HttpRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface HttpResponse {
  status: number;
  body: string;
}

export type Transport = (request: HttpRequest) => Promise<HttpResponse>;

/** Google replied, and said no. Carries the status so callers can branch. */
export class GoogleApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly reason?: string
  ) {
    super(message);
    this.name = 'GoogleApiError';
  }

  /** The sync cursor has expired; the caller must start again from scratch. */
  get isGone(): boolean {
    return this.status === 410;
  }

  /** The refresh token has been revoked or the grant withdrawn. */
  get isAuthFailure(): boolean {
    return this.status === 401 || this.reason === 'invalid_grant';
  }

  /** Worth trying again later rather than surfacing to the user. */
  get isTransient(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

export function defaultTransport(): Transport {
  return async ({ method, url, headers, body }) => {
    const response = await fetch(url, { method, headers, body });
    return { status: response.status, body: await response.text() };
  };
}

/**
 * Read the JSON body, or raise a `GoogleApiError` carrying Google's own
 * explanation.
 *
 * Google returns two different error shapes depending on which endpoint you
 * hit — `{error: {message, errors: [{reason}]}}` from the Calendar API and
 * `{error, error_description}` from the OAuth endpoints — so both are read.
 * The reason string matters: `invalid_grant` is the difference between "retry
 * this" and "make the user reconnect".
 */
export function readJson<T>(response: HttpResponse, what: string): T {
  let parsed: unknown = null;
  if (response.body) {
    try {
      parsed = JSON.parse(response.body);
    } catch {
      parsed = null;
    }
  }

  if (response.status >= 200 && response.status < 300) {
    return (parsed ?? {}) as T;
  }

  const payload = (parsed ?? {}) as {
    error?: string | { message?: string; errors?: { reason?: string }[] };
    error_description?: string;
  };

  let message: string | undefined;
  let reason: string | undefined;

  if (typeof payload.error === 'string') {
    reason = payload.error;
    message = payload.error_description ?? payload.error;
  } else if (payload.error) {
    message = payload.error.message;
    reason = payload.error.errors?.[0]?.reason;
  }

  throw new GoogleApiError(
    response.status,
    `${what}: ${message ?? `Google returned ${response.status}`}`,
    reason
  );
}

/** `?a=1&b=2`, skipping anything unset. */
export function query(params: Record<string, string | number | boolean | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const rendered = search.toString();
  return rendered ? `?${rendered}` : '';
}

/**
 * Turning form fields into typed payloads, with the database's own rules
 * checked first.
 *
 * Every constraint here also exists in Postgres — `probability between 0 and
 * 100`, `contract_months > 0`, `ends_at >= starts_at`, notes needing a subject.
 * Postgres is the guarantee; this layer exists so the user reads "Probability
 * must be between 0 and 100" instead of
 * `new row violates check constraint "opportunities_probability_check"`.
 *
 * Anything absent becomes NULL rather than an empty string. A blank field means
 * "not known", and storing "" would make an unanswered question look answered.
 */

import { ValidationError } from './errors';

/** Wall-clock times are entered in this zone unless a record names its own. */
export const DEFAULT_TIMEZONE = 'Europe/London';

// ---------------------------------------------------------------------------
// Field readers
// ---------------------------------------------------------------------------
export function text(form: FormData, field: string, label: string): string {
  const value = String(form.get(field) ?? '').trim();
  if (!value) throw new ValidationError(`${label} is required.`);
  return value;
}

export function optionalText(form: FormData, field: string): string | null {
  const value = String(form.get(field) ?? '').trim();
  return value.length ? value : null;
}

export function bool(form: FormData, field: string): boolean {
  // An unchecked checkbox is absent from the payload entirely.
  return form.get(field) !== null;
}

export function uuid(form: FormData, field: string, label: string): string {
  const value = text(form, field, label);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new ValidationError(`${label} is not a valid id.`);
  }
  return value;
}

export function optionalUuid(form: FormData, field: string): string | null {
  const value = optionalText(form, field);
  if (value === null) return null;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new ValidationError('An id in this form was not valid.');
  }
  return value;
}

export function optionalInt(
  form: FormData,
  field: string,
  label: string,
  { min, max }: { min?: number; max?: number } = {}
): number | null {
  const raw = optionalText(form, field);
  if (raw === null) return null;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new ValidationError(`${label} must be a whole number.`);
  if (min !== undefined && value < min) throw new ValidationError(`${label} must be at least ${min}.`);
  if (max !== undefined && value > max) throw new ValidationError(`${label} must be at most ${max}.`);
  return value;
}

/** Money. Rejects negatives — a fee below zero is a data-entry slip, not a discount. */
export function optionalMoney(form: FormData, field: string, label: string): number | null {
  const raw = optionalText(form, field);
  if (raw === null) return null;
  const value = Number(raw.replace(/[£$,\s]/g, ''));
  if (!Number.isFinite(value)) throw new ValidationError(`${label} must be a number.`);
  if (value < 0) throw new ValidationError(`${label} cannot be negative.`);
  if (value > 99_999_999) throw new ValidationError(`${label} is implausibly large.`);
  return Math.round(value * 100) / 100;
}

export function optionalDate(form: FormData, field: string, label: string): string | null {
  const value = optionalText(form, field);
  if (value === null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new ValidationError(`${label} must be a date.`);
  return value;
}

export function enumValue<T extends string>(
  form: FormData,
  field: string,
  allowed: readonly T[],
  label: string,
  fallback?: T
): T {
  const value = optionalText(form, field);
  if (value === null) {
    if (fallback !== undefined) return fallback;
    throw new ValidationError(`${label} is required.`);
  }
  if (!(allowed as readonly string[]).includes(value)) {
    throw new ValidationError(`${value} is not a valid ${label.toLowerCase()}.`);
  }
  return value as T;
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------
/**
 * Convert a `datetime-local` value ("2026-06-15T14:00") to an instant.
 *
 * The browser sends wall-clock text with no offset, so the zone has to come
 * from somewhere: an appointment carries its own, everything else uses
 * DEFAULT_TIMEZONE. Reading it as the server's local time would be worse than
 * arbitrary — the same form would mean different instants depending on which
 * region the deployment happened to run in.
 *
 * The offset is found by probing rather than assumed, because it changes twice
 * a year: 14:00 in London is 14:00Z in January and 13:00Z in June.
 */
export function zonedToUtc(local: string, timeZone: string = DEFAULT_TIMEZONE): string {
  const [datePart, timePart = '00:00'] = local.split('T');
  const [year, month, day] = datePart.split('-').map(Number);
  const [hour, minute] = timePart.split(':').map(Number);
  if ([year, month, day, hour, minute].some((part) => !Number.isFinite(part))) {
    throw new ValidationError('That is not a valid date and time.');
  }

  const target = Date.UTC(year, month - 1, day, hour, minute);
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });

  /** The wall clock in `timeZone` at `ms`, re-encoded as a UTC epoch. */
  const asSeen = (ms: number): number => {
    const parts = Object.fromEntries(
      formatter.formatToParts(new Date(ms)).map((part) => [part.type, part.value])
    );
    return Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour) % 24,
      Number(parts.minute),
      Number(parts.second)
    );
  };

  let ms = target - (asSeen(target) - target);
  // One refinement, relative to the corrected instant, settles the DST edges.
  ms = ms - (asSeen(ms) - target);
  return new Date(ms).toISOString();
}

export function optionalTimestamp(
  form: FormData,
  field: string,
  label: string,
  timeZone: string = DEFAULT_TIMEZONE
): string | null {
  const value = optionalText(form, field);
  if (value === null) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) {
    throw new ValidationError(`${label} must be a date and time.`);
  }
  return zonedToUtc(value, timeZone);
}

export function requiredTimestamp(
  form: FormData,
  field: string,
  label: string,
  timeZone: string = DEFAULT_TIMEZONE
): string {
  const value = optionalTimestamp(form, field, label, timeZone);
  if (value === null) throw new ValidationError(`${label} is required.`);
  return value;
}

/** A named IANA zone, rejected if this runtime does not know it. */
export function timezone(form: FormData, field: string): string {
  const value = optionalText(form, field) ?? DEFAULT_TIMEZONE;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: value });
  } catch {
    throw new ValidationError(`${value} is not a recognised time zone.`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------
/** Matches the bucket's file_size_limit; checked here so the error is readable. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/**
 * Executables and scripts are refused.
 *
 * The bucket is private and files are served through short-lived signed URLs,
 * so this is not the last line of defence — but a CRM has no reason to hold a
 * .exe or an .html, and an uploaded HTML file served from a signed URL is a
 * stored-XSS delivery mechanism aimed at whoever clicks it.
 */
const BLOCKED_EXTENSIONS = new Set([
  'exe', 'dll', 'bat', 'cmd', 'com', 'scr', 'msi', 'jar', 'app', 'deb', 'rpm',
  'sh', 'bash', 'ps1', 'vbs', 'js', 'mjs', 'html', 'htm', 'svg', 'xhtml'
]);

export function uploadedFile(form: FormData, field: string): File {
  const value = form.get(field);
  if (!(value instanceof File) || value.size === 0) {
    throw new ValidationError('Choose a file to upload.');
  }
  if (value.size > MAX_UPLOAD_BYTES) {
    const megabytes = (value.size / 1024 / 1024).toFixed(1);
    throw new ValidationError(`That file is ${megabytes} MB; the limit is 25 MB.`);
  }
  const extension = value.name.split('.').pop()?.toLowerCase() ?? '';
  if (BLOCKED_EXTENSIONS.has(extension)) {
    throw new ValidationError(`.${extension} files cannot be stored in the CRM.`);
  }
  return value;
}

/**
 * A link to a document held somewhere else.
 *
 * Only http(s). A `javascript:` or `data:` URL rendered as a link is a
 * scripting hole, and the field exists for "the signed PDF lives in Dropbox".
 */
export function optionalUrl(form: FormData, field: string, label: string): string | null {
  const value = optionalText(form, field);
  if (value === null) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ValidationError(`${label} must be a full URL, starting https://`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new ValidationError(`${label} must be an http or https link.`);
  }
  return parsed.toString();
}

/**
 * Attendee email addresses, comma or newline separated.
 *
 * Validated strictly, and this is the one field where that really matters:
 * a mistyped address on an appointment with notifications on is a meeting
 * invitation delivered to a stranger. Anything that is not plausibly an
 * address is refused by name rather than quietly dropped, because a silently
 * discarded attendee is someone who never gets invited and nobody notices
 * until the call.
 *
 * Duplicates are collapsed and case is normalised, so the same person added
 * twice is one attendee.
 */
export function emailList(form: FormData, field: string): string[] {
  const raw = optionalText(form, field);
  if (raw === null) return [];

  const seen = new Set<string>();
  for (const entry of raw.split(/[,;\n]/)) {
    const address = entry.trim().toLowerCase();
    if (!address) continue;
    // Deliberately not RFC 5322: that grammar accepts things no mail server
    // wants. This is the shape of an address someone types into a form.
    if (!/^[^\s@,]+@[^\s@,.]+(\.[^\s@,.]+)+$/.test(address)) {
      throw new ValidationError(`"${entry.trim()}" is not a valid email address.`);
    }
    seen.add(address);
  }
  return Array.from(seen);
}

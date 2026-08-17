import { describe, expect, it } from 'vitest';

import { ValidationError, readableWriteError } from '../errors';
import {
  bool,
  enumValue,
  optionalDate,
  optionalInt,
  optionalMoney,
  optionalText,
  optionalTimestamp,
  optionalUuid,
  text,
  timezone,
  uuid,
  zonedToUtc
} from '../validation';

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

const ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

describe('required and optional text', () => {
  it('trims and requires', () => {
    expect(text(form({ a: '  Riverside  ' }), 'a', 'Name')).toBe('Riverside');
    expect(() => text(form({ a: '   ' }), 'a', 'Name')).toThrow(/Name is required/);
    expect(() => text(form({}), 'a', 'Name')).toThrow(ValidationError);
  });

  it('turns a blank optional field into null, not an empty string', () => {
    // "" would make an unanswered question look answered.
    expect(optionalText(form({ a: '' }), 'a')).toBeNull();
    expect(optionalText(form({ a: '  ' }), 'a')).toBeNull();
    expect(optionalText(form({}), 'a')).toBeNull();
  });
});

describe('checkboxes', () => {
  it('reads absence as false, since browsers omit unchecked boxes', () => {
    expect(bool(form({ flag: 'on' }), 'flag')).toBe(true);
    expect(bool(form({}), 'flag')).toBe(false);
  });
});

describe('ids', () => {
  it('accepts a uuid and rejects anything else', () => {
    expect(uuid(form({ id: ID }), 'id', 'Lead')).toBe(ID);
    expect(() => uuid(form({ id: 'nope' }), 'id', 'Lead')).toThrow(/not a valid id/);
    expect(optionalUuid(form({ id: '' }), 'id')).toBeNull();
  });
});

describe('numbers', () => {
  it('enforces the same bounds the database does', () => {
    expect(optionalInt(form({ p: '50' }), 'p', 'Probability', { min: 0, max: 100 })).toBe(50);
    expect(() => optionalInt(form({ p: '101' }), 'p', 'Probability', { max: 100 })).toThrow(
      /at most 100/
    );
    expect(() => optionalInt(form({ p: '0' }), 'p', 'Contract length', { min: 1 })).toThrow(
      /at least 1/
    );
    expect(() => optionalInt(form({ p: '1.5' }), 'p', 'Probability')).toThrow(/whole number/);
  });

  it('accepts money with symbols and separators', () => {
    expect(optionalMoney(form({ m: '£1,500' }), 'm', 'Monthly')).toBe(1500);
    expect(optionalMoney(form({ m: '1499.505' }), 'm', 'Monthly')).toBe(1499.51);
    expect(optionalMoney(form({ m: '' }), 'm', 'Monthly')).toBeNull();
  });

  it('rejects a negative fee as the typo it is', () => {
    expect(() => optionalMoney(form({ m: '-100' }), 'm', 'Setup fee')).toThrow(/cannot be negative/);
  });
});

describe('dates and enums', () => {
  it('requires a full date', () => {
    expect(optionalDate(form({ d: '2026-08-17' }), 'd', 'Close date')).toBe('2026-08-17');
    expect(() => optionalDate(form({ d: '17/08/2026' }), 'd', 'Close date')).toThrow(/must be a date/);
  });

  it('rejects a value outside the enum', () => {
    const stages = ['discovery', 'won'] as const;
    expect(enumValue(form({ s: 'won' }), 's', stages, 'Stage')).toBe('won');
    expect(() => enumValue(form({ s: 'invented' }), 's', stages, 'Stage')).toThrow(/not a valid/);
    expect(enumValue(form({}), 's', stages, 'Stage', 'discovery')).toBe('discovery');
    expect(() => enumValue(form({}), 's', stages, 'Stage')).toThrow(/required/);
  });
});

/**
 * A `datetime-local` field sends wall-clock text with no offset. Reading it as
 * the server's local time would make the same form mean different instants
 * depending on where the deployment runs, so the zone is explicit — and the
 * offset has to be looked up, because it moves twice a year.
 */
describe('zonedToUtc', () => {
  it('applies GMT in winter and BST in summer', () => {
    expect(zonedToUtc('2026-01-15T14:00', 'Europe/London')).toBe('2026-01-15T14:00:00.000Z');
    expect(zonedToUtc('2026-06-15T14:00', 'Europe/London')).toBe('2026-06-15T13:00:00.000Z');
  });

  it('handles a zone that is not the default', () => {
    expect(zonedToUtc('2026-06-15T09:00', 'America/New_York')).toBe('2026-06-15T13:00:00.000Z');
    expect(zonedToUtc('2026-06-15T14:00', 'UTC')).toBe('2026-06-15T14:00:00.000Z');
  });

  it('round-trips midnight without slipping a day', () => {
    expect(zonedToUtc('2026-06-15T00:00', 'Europe/London')).toBe('2026-06-14T23:00:00.000Z');
  });

  it('defaults to UK time', () => {
    expect(zonedToUtc('2026-06-15T14:00')).toBe(zonedToUtc('2026-06-15T14:00', 'Europe/London'));
  });

  it('rejects an unknown zone rather than silently using UTC', () => {
    expect(() => timezone(form({ tz: 'Mars/Olympus' }), 'tz')).toThrow(/not a recognised time zone/);
    expect(timezone(form({}), 'tz')).toBe('Europe/London');
  });

  it('is applied by optionalTimestamp', () => {
    expect(optionalTimestamp(form({ t: '2026-06-15T14:00' }), 't', 'Due', 'Europe/London')).toBe(
      '2026-06-15T13:00:00.000Z'
    );
    expect(optionalTimestamp(form({ t: '' }), 't', 'Due')).toBeNull();
    expect(() => optionalTimestamp(form({ t: 'tomorrow' }), 't', 'Due')).toThrow(/date and time/);
  });
});

/**
 * Postgres constraint messages are accurate and unreadable. The ones a user can
 * actually hit get a sentence explaining what to do about it.
 */
describe('readableWriteError', () => {
  it('explains the constraints a user can trip', () => {
    const cases: [string, RegExp][] = [
      ['duplicate key value violates unique constraint "contacts_one_primary_per_lead"',
        /already has a primary contact/],
      ['new row violates check constraint "appointments_ends_after_starts"',
        /end time cannot be before/],
      ['new row violates check constraint "notes_has_subject_entity"',
        /lead, a client or an appointment/],
      ['new row violates check constraint "opportunities_probability_check"',
        /between 0 and 100/],
      ['new row violates row-level security policy for table "tasks"',
        /role may have changed/]
    ];
    for (const [postgres, expected] of cases) {
      expect(readableWriteError(new Error(postgres))).toMatch(expected);
    }
  });

  it('passes a validation message through untouched', () => {
    expect(readableWriteError(new ValidationError('A contact needs a name.'))).toBe(
      'A contact needs a name.'
    );
  });

  it('does not swallow an error it has no translation for', () => {
    // An internal tool showing its real error beats a shrug.
    expect(readableWriteError(new Error('connection terminated unexpectedly'))).toBe(
      'connection terminated unexpectedly'
    );
  });
});

// ---------------------------------------------------------------------------
// Uploads and links
// ---------------------------------------------------------------------------
import { MAX_UPLOAD_BYTES, optionalUrl, uploadedFile } from '../validation';

function formWithFile(name: string, bytes: number, type = 'application/pdf'): FormData {
  const data = new FormData();
  data.append('file', new File([new Uint8Array(bytes)], name, { type }));
  return data;
}

describe('uploads', () => {
  it('accepts an ordinary document', () => {
    const file = uploadedFile(formWithFile('contract.pdf', 1024), 'file');
    expect(file.name).toBe('contract.pdf');
  });

  it('requires a file to have been chosen', () => {
    expect(() => uploadedFile(new FormData(), 'file')).toThrow(/Choose a file/);
    expect(() => uploadedFile(formWithFile('empty.pdf', 0), 'file')).toThrow(/Choose a file/);
  });

  it('states the size in the error rather than just refusing', () => {
    expect(() => uploadedFile(formWithFile('big.pdf', MAX_UPLOAD_BYTES + 1), 'file')).toThrow(
      /the limit is 25 MB/
    );
  });

  /**
   * The bucket is private and served through signed URLs, so this is not the
   * last line of defence — but an uploaded HTML or SVG file opened from a
   * signed URL is a stored-XSS delivery mechanism aimed at whoever clicks it.
   */
  it('refuses executables, scripts and anything that renders as a page', () => {
    for (const name of ['setup.exe', 'run.sh', 'payload.js', 'invoice.html', 'logo.svg']) {
      expect(() => uploadedFile(formWithFile(name, 512), 'file')).toThrow(/cannot be stored/);
    }
  });

  it('is not fooled by the declared MIME type', () => {
    // The browser sets Content-Type; only the extension is trusted here.
    expect(() => uploadedFile(formWithFile('x.html', 512, 'application/pdf'), 'file')).toThrow(
      /cannot be stored/
    );
  });
});

describe('document links', () => {
  it('accepts http and https', () => {
    expect(optionalUrl(form({ u: 'https://example.com/a.pdf' }), 'u', 'Doc')).toBe(
      'https://example.com/a.pdf'
    );
    expect(optionalUrl(form({ u: '' }), 'u', 'Doc')).toBeNull();
  });

  it('rejects scheme-based scripting holes', () => {
    for (const value of ['javascript:alert(1)', 'data:text/html,<script>x</script>', 'not a url']) {
      expect(() => optionalUrl(form({ u: value }), 'u', 'Doc')).toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// Attendees
// ---------------------------------------------------------------------------
import { emailList } from '../validation';

/**
 * The one field where a validation slip leaves the building: an appointment
 * with notifications on hands these addresses to Google, which emails them.
 */
describe('attendee emails', () => {
  it('splits on commas, semicolons and newlines', () => {
    expect(emailList(form({ a: 'one@x.co.uk, two@y.com;three@z.io' }), 'a')).toEqual([
      'one@x.co.uk',
      'two@y.com',
      'three@z.io'
    ]);
    expect(emailList(form({ a: 'one@x.com\ntwo@y.com' }), 'a')).toEqual([
      'one@x.com',
      'two@y.com'
    ]);
  });

  it('treats no attendees as an empty list, not a blank one', () => {
    expect(emailList(form({ a: '' }), 'a')).toEqual([]);
    expect(emailList(form({}), 'a')).toEqual([]);
    expect(emailList(form({ a: ' , , ' }), 'a')).toEqual([]);
  });

  it('collapses the same person added twice', () => {
    expect(emailList(form({ a: 'Owner@Practice.test, owner@practice.test' }), 'a')).toEqual([
      'owner@practice.test'
    ]);
  });

  it('names a bad address rather than quietly dropping it', () => {
    // A silently discarded attendee is someone who never gets invited and
    // nobody finds out until the call.
    for (const bad of ['not-an-email', 'missing@tld', '@nodomain.com', 'spaces in@x.com']) {
      expect(() => emailList(form({ a: `good@x.com, ${bad}` }), 'a')).toThrow(/not a valid email/);
    }
  });
});

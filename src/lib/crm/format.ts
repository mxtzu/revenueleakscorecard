/**
 * Display formatting for the CRM.
 *
 * All of it is null-tolerant: most intelligence fields are legitimately absent
 * (a business with no website has no website score), and a dash is a truthful
 * rendering of "we don't know". Never substitute a zero for missing data — the
 * pipeline's whole discipline is not claiming more than the source supports.
 */

const EM_DASH = '—';

export function formatMoney(
  amount: number | null | undefined,
  currency = 'GBP'
): string {
  if (amount === null || amount === undefined || !Number.isFinite(Number(amount))) return EM_DASH;
  return new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency,
    maximumFractionDigits: Number(amount) % 1 === 0 ? 0 : 2
  }).format(Number(amount));
}

export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return EM_DASH;
  return new Intl.NumberFormat('en-GB').format(Number(value));
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return EM_DASH;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return EM_DASH;
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric'
  }).format(date);
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return EM_DASH;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return EM_DASH;
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date);
}

export function formatTime(value: string | null | undefined): string {
  if (!value) return EM_DASH;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return EM_DASH;
  return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' }).format(date);
}

/** "3 days ago" / "in 2 hours". Used for anything time-sensitive in a list. */
export function formatRelative(value: string | null | undefined): string {
  if (!value) return EM_DASH;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return EM_DASH;

  const seconds = Math.round((date.getTime() - Date.now()) / 1000);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 31_536_000],
    ['month', 2_592_000],
    ['week', 604_800],
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60]
  ];
  const relative = new Intl.RelativeTimeFormat('en-GB', { numeric: 'auto' });
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit);
  }
  return relative.format(Math.round(seconds), 'second');
}

export function isOverdue(value: string | null | undefined): boolean {
  if (!value) return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.getTime() < Date.now();
}

/** snake_case enum value -> "Snake case". */
export function humanise(value: string | null | undefined): string {
  if (!value) return EM_DASH;
  const text = value.replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function orDash(value: string | null | undefined): string {
  return value && value.trim().length ? value : EM_DASH;
}

/** Strip the scheme so a long URL fits a table cell. */
export function displayUrl(value: string | null | undefined): string {
  if (!value) return EM_DASH;
  return value.replace(/^https?:\/\//i, '').replace(/\/$/, '');
}

/** Byte counts, at the precision a human reading a file list cares about. */
export function formatFileSize(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(Number(bytes))) return EM_DASH;
  const size = Number(bytes);
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export { EM_DASH };

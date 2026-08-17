/**
 * Form primitives for the CRM.
 *
 * Server components throughout — no client JavaScript anywhere in this file.
 * Create and edit are plain `<form action={serverAction}>`, and the disclosure
 * pattern below uses `<details>`, which the browser opens and closes on its
 * own. That keeps every page server-rendered and means the forms still work
 * before hydration, or without it.
 *
 * Deletes are two-step for the same reason: a `confirm()` dialog needs an
 * onClick handler, so instead the button hides inside a disclosure the user has
 * to open. Two deliberate clicks, no script.
 */

import type { ReactNode } from 'react';

const CONTROL =
  'w-full rounded-lg border border-line bg-ink-800 px-3 py-2 text-sm text-white placeholder:text-white/25 disabled:opacity-40';

export function Label({ children, hint }: { children: ReactNode; hint?: string }) {
  return (
    <span className="label-mono text-white/40">
      {children}
      {hint ? <span className="ml-1 normal-case tracking-normal text-white/25">{hint}</span> : null}
    </span>
  );
}

export function TextField({
  name,
  label,
  defaultValue,
  placeholder,
  type = 'text',
  required,
  hint,
  className = ''
}: {
  name: string;
  label: string;
  defaultValue?: string | null;
  placeholder?: string;
  type?: 'text' | 'email' | 'tel' | 'url' | 'number' | 'date' | 'datetime-local';
  required?: boolean;
  hint?: string;
  className?: string;
}) {
  return (
    <label className={`block ${className}`}>
      <Label hint={hint}>{label}</Label>
      <input
        type={type}
        name={name}
        defaultValue={defaultValue ?? ''}
        placeholder={placeholder}
        required={required}
        // Money and percentages are the only numbers here; both want decimals
        // off unless explicitly wanted.
        step={type === 'number' ? 'any' : undefined}
        className={`mt-1.5 ${CONTROL}`}
      />
    </label>
  );
}

export function TextAreaField({
  name,
  label,
  defaultValue,
  placeholder,
  rows = 3,
  required,
  className = ''
}: {
  name: string;
  label: string;
  defaultValue?: string | null;
  placeholder?: string;
  rows?: number;
  required?: boolean;
  className?: string;
}) {
  return (
    <label className={`block ${className}`}>
      <Label>{label}</Label>
      <textarea
        name={name}
        rows={rows}
        required={required}
        defaultValue={defaultValue ?? ''}
        placeholder={placeholder}
        className={`mt-1.5 ${CONTROL}`}
      />
    </label>
  );
}

export interface Option {
  value: string;
  label: string;
}

export function SelectField({
  name,
  label,
  options,
  defaultValue,
  placeholder,
  className = ''
}: {
  name: string;
  label: string;
  options: Option[];
  defaultValue?: string | null;
  /** Renders an empty first option — the way to express "not set". */
  placeholder?: string;
  className?: string;
}) {
  return (
    <label className={`block ${className}`}>
      <Label>{label}</Label>
      <select name={name} defaultValue={defaultValue ?? ''} className={`mt-1.5 ${CONTROL}`}>
        {placeholder ? <option value="">{placeholder}</option> : null}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function CheckboxField({
  name,
  label,
  defaultChecked,
  hint
}: {
  name: string;
  label: string;
  defaultChecked?: boolean;
  hint?: string;
}) {
  return (
    <label className="flex items-start gap-2.5 py-1">
      <input
        type="checkbox"
        name={name}
        defaultChecked={defaultChecked}
        className="mt-0.5 h-4 w-4 rounded border-line bg-ink-800 accent-electric-500"
      />
      <span className="text-sm text-white/75">
        {label}
        {hint ? <span className="mt-0.5 block text-xs text-white/35">{hint}</span> : null}
      </span>
    </label>
  );
}

export function FormGrid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">{children}</div>;
}

export function SubmitButton({
  children,
  tone = 'primary'
}: {
  children: ReactNode;
  tone?: 'primary' | 'quiet' | 'danger';
}) {
  const classes = {
    primary: 'bg-electric-500 text-white hover:bg-electric-600',
    quiet: 'border border-line text-white/80 hover:border-electric-500/50',
    danger: 'border border-rose-400/40 text-rose-200 hover:bg-rose-400/10'
  }[tone];
  return (
    <button type="submit" className={`rounded-lg px-4 py-2 text-sm font-medium ${classes}`}>
      {children}
    </button>
  );
}

/**
 * A collapsed section that opens on click. Used for "Add …" and "Edit" so a
 * list of twenty records is not also twenty open forms.
 */
export function Disclosure({
  summary,
  children,
  tone = 'quiet',
  open
}: {
  summary: string;
  children: ReactNode;
  tone?: 'quiet' | 'primary' | 'danger';
  open?: boolean;
}) {
  const summaryTone = {
    quiet: 'text-white/55 hover:text-white/85',
    primary: 'text-electric-300 hover:text-electric-400',
    danger: 'text-rose-300 hover:text-rose-200'
  }[tone];
  return (
    <details open={open} className="group">
      <summary className={`cursor-pointer list-none text-sm ${summaryTone}`}>
        <span className="inline-block transition-transform group-open:rotate-90">›</span> {summary}
      </summary>
      <div className="mt-3">{children}</div>
    </details>
  );
}

/**
 * Delete, behind a disclosure.
 *
 * Deletion is admin-only in RLS, so this renders nothing for everyone else
 * rather than offering a button the database will refuse.
 */
export function DeleteForm({
  action,
  id,
  hidden,
  label,
  warning,
  allowed
}: {
  action: (formData: FormData) => void | Promise<void>;
  id: string;
  /** Extra hidden fields the action needs, e.g. the parent lead id. */
  hidden?: Record<string, string | null | undefined>;
  label: string;
  warning: string;
  allowed: boolean;
}) {
  if (!allowed) return null;
  return (
    <Disclosure summary={label} tone="danger">
      <form action={action} className="space-y-2">
        <input type="hidden" name="id" value={id} />
        {Object.entries(hidden ?? {}).map(([name, value]) =>
          value ? <input key={name} type="hidden" name={name} value={value} /> : null
        )}
        <p className="text-xs text-white/50">{warning}</p>
        <SubmitButton tone="danger">Yes, delete permanently</SubmitButton>
      </form>
    </Disclosure>
  );
}

/** Carries the current path so the action can send the browser back to it. */
export function ReturnTo({ path }: { path: string }) {
  return <input type="hidden" name="return_to" value={path} />;
}

/** The banner every page shows when an action redirects back with `?error=`. */
export function ActionError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <div
      role="alert"
      className="mb-4 rounded-lg border border-rose-400/25 bg-rose-400/5 px-4 py-3 text-sm text-rose-200"
    >
      {message}
    </div>
  );
}

/** Shown in place of a create form when the viewer's role cannot write. */
export function ReadOnlyNotice({ what }: { what: string }) {
  return (
    <p className="rounded-lg border border-line bg-white/[0.02] px-3 py-2 text-xs text-white/45">
      Read-only: your role cannot {what}.
    </p>
  );
}

/** `datetime-local` wants "YYYY-MM-DDTHH:mm" rendered in a specific zone. */
export function toLocalInput(iso: string | null | undefined, timeZone = 'Europe/London'): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value])
  );
  const hour = parts.hour === '24' ? '00' : parts.hour;
  return `${parts.year}-${parts.month}-${parts.day}T${hour}:${parts.minute}`;
}

/** `<input type="date">` wants "YYYY-MM-DD". */
export function toDateInput(value: string | null | undefined): string {
  return value ? value.slice(0, 10) : '';
}

export function optionsFrom(
  values: readonly string[],
  labels?: Record<string, string>
): Option[] {
  return values.map((value) => ({
    value,
    label: labels?.[value] ?? value.charAt(0).toUpperCase() + value.slice(1).replace(/_/g, ' ')
  }));
}

/**
 * The counterpart to ActionError, for something that went right.
 *
 * Green rather than red, because "Synced — 3 sent, 1 received" and "the
 * database refused that write" arriving in the same grey box is how people
 * stop reading either.
 */
export function ActionNotice({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <div
      role="status"
      className="mb-4 rounded-lg border border-emerald-400/25 bg-emerald-400/5 px-4 py-3 text-sm text-emerald-200"
    >
      {message}
    </div>
  );
}

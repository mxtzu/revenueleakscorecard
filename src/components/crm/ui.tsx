/**
 * CRM UI primitives.
 *
 * Server components (no "use client") so pages stay streaming-friendly. They
 * reuse the existing scorecard design tokens — ink/line/electric, the mono
 * label style — rather than introducing a second visual language.
 */

import Link from 'next/link';
import type { ReactNode } from 'react';

import { PIPELINE_STAGE_LABELS, type PipelineStage } from '@/lib/crm/types';

export function PageHeader({
  eyebrow,
  title,
  description,
  actions
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-8 flex flex-wrap items-end justify-between gap-4">
      <div>
        {eyebrow ? <p className="label-mono mb-2 text-electric-300">{eyebrow}</p> : null}
        <h1 className="display text-3xl text-white sm:text-4xl">{title}</h1>
        {description ? (
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-white/55">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </header>
  );
}

export function Card({
  title,
  description,
  actions,
  children,
  className = ''
}: {
  title?: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-xl border border-line bg-ink-900/70 shadow-card ${className}`}
    >
      {title ? (
        <div className="flex items-start justify-between gap-4 border-b border-line-soft px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold tracking-tight text-white">{title}</h2>
            {description ? <p className="mt-1 text-xs text-white/45">{description}</p> : null}
          </div>
          {actions}
        </div>
      ) : null}
      <div className="px-5 py-4">{children}</div>
    </section>
  );
}

export function StatCard({
  label,
  value,
  hint,
  href
}: {
  label: string;
  value: string | number;
  hint?: string;
  href?: string;
}) {
  const body = (
    <div className="rounded-xl border border-line bg-ink-900/70 px-5 py-4 shadow-card transition-colors hover:border-electric-500/40">
      <p className="label-mono text-white/40">{label}</p>
      <p className="mt-2 font-mono text-2xl text-white">{value}</p>
      {hint ? <p className="mt-1 text-xs text-white/40">{hint}</p> : null}
    </div>
  );
  return href ? (
    <Link href={href} className="block">
      {body}
    </Link>
  ) : (
    body
  );
}

type Tone = 'neutral' | 'positive' | 'warning' | 'danger' | 'info';

const TONE_CLASSES: Record<Tone, string> = {
  neutral: 'border-white/10 bg-white/5 text-white/65',
  positive: 'border-emerald-400/25 bg-emerald-400/10 text-emerald-200',
  warning: 'border-amber-400/25 bg-amber-400/10 text-amber-200',
  danger: 'border-rose-400/25 bg-rose-400/10 text-rose-200',
  info: 'border-electric-500/30 bg-electric-500/10 text-electric-300'
};

export function Badge({
  children,
  tone = 'neutral',
  title
}: {
  children: ReactNode;
  tone?: Tone;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={`inline-flex items-center whitespace-nowrap rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${TONE_CLASSES[tone]}`}
    >
      {children}
    </span>
  );
}

const STAGE_TONES: Record<PipelineStage, Tone> = {
  qualified: 'neutral',
  ready_for_outreach: 'info',
  contacted: 'info',
  replied: 'positive',
  appointment_booked: 'positive',
  sales_call: 'positive',
  proposal: 'warning',
  negotiation: 'warning',
  won: 'positive',
  lost: 'danger',
  disqualified: 'danger',
  do_not_contact: 'danger'
};

export function StageBadge({ stage }: { stage: PipelineStage }) {
  return <Badge tone={STAGE_TONES[stage]}>{PIPELINE_STAGE_LABELS[stage]}</Badge>;
}

/**
 * The score badge is colour-coded, but the number is always shown. A colour is
 * a hint; the figure is the claim.
 */
export function ScoreBadge({ score }: { score: number | null | undefined }) {
  if (score === null || score === undefined) return <Badge tone="neutral">No score</Badge>;
  const value = Number(score);
  const tone: Tone = value >= 80 ? 'positive' : value >= 60 ? 'info' : value >= 40 ? 'warning' : 'neutral';
  return <Badge tone={tone}>{value.toFixed(0)}</Badge>;
}

/**
 * Advertising status uses the pipeline's own vocabulary. `likely`/`possible`
 * are inferences, not observations, so they never render as a positive.
 */
export function AdvertisingBadge({ status }: { status: string | null | undefined }) {
  if (!status) return <Badge tone="neutral">Unknown</Badge>;
  const tone: Tone =
    status === 'confirmed'
      ? 'positive'
      : status === 'likely'
        ? 'info'
        : status === 'possible'
          ? 'warning'
          : 'neutral';
  const labels: Record<string, string> = {
    confirmed: 'Confirmed',
    likely: 'Likely',
    possible: 'Possible',
    not_detected: 'Not detected',
    unknown: 'Unknown'
  };
  return (
    <Badge tone={tone} title={`Evidence level: ${status}`}>
      {labels[status] ?? status}
    </Badge>
  );
}

export function EmptyState({
  title,
  description,
  action
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-dashed border-line px-6 py-10 text-center">
      <p className="text-sm font-medium text-white/70">{title}</p>
      {description ? (
        <p className="mx-auto mt-2 max-w-md text-xs leading-relaxed text-white/40">{description}</p>
      ) : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function Table({ head, children }: { head: ReactNode[]; children: ReactNode }) {
  return (
    <div className="-mx-5 overflow-x-auto px-5">
      <table className="w-full min-w-[640px] border-collapse text-sm">
        <thead>
          <tr className="border-b border-line-soft">
            {head.map((cell, index) => (
              <th
                key={index}
                className="label-mono whitespace-nowrap px-3 py-2 text-left font-medium text-white/35"
              >
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function Row({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <tr className={`border-b border-line-soft/60 last:border-0 hover:bg-white/[0.02] ${className}`}>
      {children}
    </tr>
  );
}

export function Cell({
  children,
  className = '',
  colSpan,
  title
}: {
  children: ReactNode;
  className?: string;
  colSpan?: number;
  title?: string;
}) {
  return (
    <td colSpan={colSpan} title={title} className={`px-3 py-3 align-middle text-white/75 ${className}`}>
      {children}
    </td>
  );
}

/** Label/value pair used throughout the detail pages. */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="label-mono text-white/35">{label}</dt>
      <dd className="mt-1 break-words text-sm text-white/80">{children}</dd>
    </div>
  );
}

export function FieldGrid({ children }: { children: ReactNode }) {
  return <dl className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">{children}</dl>;
}

export function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer nofollow"
      className="text-electric-300 underline-offset-2 hover:underline"
    >
      {children}
    </a>
  );
}

/**
 * Renders a pipeline analysis blob (website_analysis, advertising_analysis,
 * score_breakdown) without hard-coding its keys.
 *
 * The pipeline's analysis shape evolves — new signals get added as detection
 * improves. A generic renderer means a new signal shows up in the CRM the next
 * time the sync runs, with no migration and no UI change. Keys are humanised
 * rather than relabelled, so what you read here is what the pipeline recorded.
 *
 * Null and undefined values are omitted entirely: "we didn't determine this" is
 * not the same claim as "no", and showing a grey "No" would state the stronger
 * one.
 */

import { Badge } from './ui';

const HIDE = new Set(['website', 'domain', 'url', 'checked_at', 'analysed_at']);

function label(key: string): string {
  const text = key.replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function Value({ value }: { value: unknown }) {
  if (typeof value === 'boolean') {
    return <Badge tone={value ? 'positive' : 'neutral'}>{value ? 'Yes' : 'No'}</Badge>;
  }
  if (typeof value === 'number') {
    return <span className="font-mono text-white/80">{value}</span>;
  }
  if (Array.isArray(value)) {
    if (!value.length) return <span className="text-white/30">None</span>;
    return (
      <span className="flex flex-wrap gap-1">
        {value.map((item, index) => (
          <Badge key={index}>{String(item)}</Badge>
        ))}
      </span>
    );
  }
  return <span className="text-white/80">{String(value)}</span>;
}

export function AnalysisGrid({ data }: { data: Record<string, unknown> | null }) {
  if (!data) {
    return (
      <p className="text-sm text-white/35">
        Not analysed. Re-run the pipeline with website analysis enabled and re-sync.
      </p>
    );
  }

  const entries = Object.entries(data).filter(
    ([key, value]) =>
      !HIDE.has(key) &&
      value !== null &&
      value !== undefined &&
      !(typeof value === 'object' && !Array.isArray(value))
  );

  if (!entries.length) {
    return <p className="text-sm text-white/35">No signals recorded.</p>;
  }

  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
      {entries.map(([key, value]) => (
        <div key={key} className="flex items-start justify-between gap-3 border-b border-line-soft/50 pb-2">
          <dt className="text-xs text-white/45">{label(key)}</dt>
          <dd className="text-right text-sm">
            <Value value={value} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

import Link from 'next/link';

/**
 * A lead or client id that does not resolve — usually a stale link, or a record
 * an admin deleted. Distinct from an error: nothing failed, the row is gone.
 */
export default function CrmNotFound() {
  return (
    <div className="mx-auto max-w-xl rounded-xl border border-line bg-ink-900/70 p-6 shadow-card">
      <p className="label-mono text-white/40">404</p>
      <h1 className="display mt-1 text-2xl text-white">Record not found</h1>
      <p className="mt-3 text-sm leading-relaxed text-white/60">
        This record does not exist, or it was deleted. If you followed a link from outside the CRM,
        it may be pointing at a lead from a database that has since been rebuilt.
      </p>
      <div className="mt-5 flex flex-wrap gap-2">
        <Link
          href="/leads"
          className="rounded-lg bg-electric-500 px-4 py-2 text-sm font-medium text-white hover:bg-electric-600"
        >
          All leads
        </Link>
        <Link
          href="/dashboard"
          className="rounded-lg border border-line px-4 py-2 text-sm text-white/70 hover:border-electric-500/50"
        >
          Dashboard
        </Link>
      </div>
    </div>
  );
}

/**
 * Shown while a CRM page's queries resolve.
 *
 * Every page is server-rendered per request against a remote database, so there
 * is a real gap before anything paints. Without this the browser sits on the
 * previous page and the click appears to have done nothing.
 */
export default function CrmLoading() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Loading">
      <div className="h-9 w-56 animate-pulse rounded-lg bg-white/5" />
      <div className="h-4 w-80 animate-pulse rounded bg-white/5" />
      <div className="grid grid-cols-2 gap-3 pt-4 lg:grid-cols-4">
        {[0, 1, 2, 3].map((index) => (
          <div key={index} className="h-24 animate-pulse rounded-xl border border-line bg-white/[0.03]" />
        ))}
      </div>
      <div className="h-64 animate-pulse rounded-xl border border-line bg-white/[0.03]" />
    </div>
  );
}

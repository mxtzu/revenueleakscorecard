'use client';

import { useRef, useState } from 'react';

const STAGES = [
  ['qualified', 'Qualified'],
  ['ready_for_outreach', 'Ready for outreach'],
  ['contacted', 'Contacted'],
  ['replied', 'Replied']
] as const;

interface SyncResult {
  received: number;
  skippedBelowMinScore: number;
  skippedInvalid: number;
  crmLeadsCreated: number;
  crmLeadsExisting: number;
  intelligenceUpserted: number;
  errors: string[];
}

export function ImportLeads() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [minScore, setMinScore] = useState('0');
  const [stage, setStage] = useState('qualified');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SyncResult | null>(null);

  function reset() {
    setFile(null);
    setMinScore('0');
    setStage('qualified');
    setBusy(false);
    setError(null);
    setResult(null);
    if (inputRef.current) inputRef.current.value = '';
  }

  function close() {
    if (busy) return;
    setOpen(false);
    reset();
  }

  async function importLeads() {
    if (!file) {
      setError('Choose a JSON export first.');
      return;
    }

    setBusy(true);
    setError(null);
    setResult(null);

    const form = new FormData();
    form.append('file', file);
    form.append('min_score', minScore);
    form.append('stage', stage);

    try {
      const response = await fetch('/api/crm/import-leads', {
        method: 'POST',
        body: form
      });
      const body = await response.json();

      if (!response.ok && response.status !== 207) {
        throw new Error(body.error || 'Lead import failed.');
      }

      setResult(body.result as SyncResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Lead import failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-lg border border-line bg-ink-800 px-4 py-2 text-sm font-medium text-white hover:border-white/20 hover:bg-ink-700"
      >
        Import leads
      </button>

      {open ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" role="dialog" aria-modal="true" aria-labelledby="import-leads-title">
          <div className="w-full max-w-lg rounded-2xl border border-line bg-ink-900 p-6 shadow-2xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="label-mono text-electric-300/80">Lead pipeline</p>
                <h2 id="import-leads-title" className="mt-1 text-xl font-semibold text-white">Import leads</h2>
                <p className="mt-1 text-sm text-white/45">
                  Upload the JSON export from the local-business lead pipeline. Existing CRM state is preserved.
                </p>
              </div>
              <button type="button" onClick={close} disabled={busy} className="text-white/40 hover:text-white disabled:opacity-30" aria-label="Close">
                ×
              </button>
            </div>

            <div className="mt-6 space-y-4">
              <label className="block">
                <span className="label-mono text-white/45">JSON export</span>
                <input
                  ref={inputRef}
                  type="file"
                  accept="application/json,.json"
                  onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                  className="mt-1.5 block w-full rounded-lg border border-line bg-ink-800 px-3 py-2 text-sm text-white file:mr-3 file:rounded-md file:border-0 file:bg-white/10 file:px-3 file:py-1.5 file:text-sm file:text-white"
                />
              </label>

              <div className="grid grid-cols-2 gap-3">
                <label>
                  <span className="label-mono text-white/45">Minimum score</span>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    value={minScore}
                    onChange={(event) => setMinScore(event.target.value)}
                    className="mt-1.5 w-full rounded-lg border border-line bg-ink-800 px-3 py-2 text-sm text-white"
                  />
                </label>
                <label>
                  <span className="label-mono text-white/45">Initial stage</span>
                  <select
                    value={stage}
                    onChange={(event) => setStage(event.target.value)}
                    className="mt-1.5 w-full rounded-lg border border-line bg-ink-800 px-3 py-2 text-sm text-white"
                  >
                    {STAGES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                </label>
              </div>

              <div className="rounded-lg border border-line bg-ink-800/60 p-3 text-xs leading-5 text-white/45">
                Re-importing the same export is safe. Intelligence is refreshed, while pipeline stage, owner, activities, opportunities, clients and payments are left untouched.
              </div>

              {error ? <div className="rounded-lg border border-red-400/20 bg-red-400/5 p-3 text-sm text-red-200">{error}</div> : null}

              {result ? (
                <div className="rounded-lg border border-emerald-400/20 bg-emerald-400/5 p-4">
                  <p className="text-sm font-medium text-emerald-200">Import complete</p>
                  <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-white/55">
                    <span>Received: <b className="text-white">{result.received}</b></span>
                    <span>Created: <b className="text-white">{result.crmLeadsCreated}</b></span>
                    <span>Existing: <b className="text-white">{result.crmLeadsExisting}</b></span>
                    <span>Intelligence: <b className="text-white">{result.intelligenceUpserted}</b></span>
                    <span>Below score: <b className="text-white">{result.skippedBelowMinScore}</b></span>
                    <span>Invalid: <b className="text-white">{result.skippedInvalid}</b></span>
                  </div>
                  {result.errors.length ? <p className="mt-3 text-xs text-amber-200">{result.errors.length} batch error(s): {result.errors.join(' ')}</p> : null}
                </div>
              ) : null}
            </div>

            <div className="mt-6 flex justify-end gap-2">
              <button type="button" onClick={close} disabled={busy} className="rounded-lg px-4 py-2 text-sm text-white/50 hover:text-white disabled:opacity-30">
                {result ? 'Done' : 'Cancel'}
              </button>
              {!result ? (
                <button
                  type="button"
                  onClick={importLeads}
                  disabled={busy || !file}
                  className="rounded-lg bg-electric-500 px-4 py-2 text-sm font-medium text-white hover:bg-electric-600 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {busy ? 'Importing…' : 'Import leads'}
                </button>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

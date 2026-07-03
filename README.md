# ASCEND Revenue Leak Scorecard

The top-of-funnel asset for ASCEND's Revenue Leak Diagnosis — a two-minute, six-question
scorecard for post-traction Roblox studios that surfaces the single worst revenue leak
across Acquisition, Activation, Monetization, Measurement, and Compounding, then routes
the operator to the paid Revenue Leak Audit.

Funnel position: tracked link (X/Discord) → scorecard → audit application → call → revenue.

## Structure

- **6 questions** (1 revenue-band baseline + 1 per leak category), each answerable from
  memory or the Creator Dashboard. Concrete answer options, no Likert scales.
- **Single-leak result**: worst-scoring category becomes the headline diagnosis. The
  result names the mechanism and echoes the operator's own answers as evidence — it never
  prescribes the fix (timing/sequencing/architecture is what the audit sells).
- **Result screen order**: category eyebrow → leak headline → evidence + why it matters →
  leak map → fragmented-hire section → proof module → audit CTA.

### The three conversion-critical components

| Component | File | Notes |
| --- | --- | --- |
| Category name label | `src/components/scorecard/CategoryNameLabel.tsx` + `src/lib/brand.ts` | "Revenue Leak Diagnosis" — change it in `brand.ts` only |
| Fragmented-hire argument | `src/components/scorecard/FragmentedHireSection.tsx` | Why three point-solution hires lose to one integrated diagnosis |
| Proof module | `src/components/scorecard/ProofModule.tsx` + `src/lib/proofConfig.ts` | Config-driven. When the STRAFE stat is verified: set `verified: true`, fill `stat`/`statLabel` in `proofConfig.ts`. Unverified stats never render. |

## Local Development

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Tracking

The app works with zero credentials configured; every destination is optional and
independent.

### Supabase (funnel store — the "Content" project)

Set in Vercel → Project Settings → Environment Variables:

```text
SUPABASE_URL=https://oiivbwvjhlrzjcphchtk.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service role secret — server-side only>
```

What gets logged:

- `scorecard_sessions` (added by `supabase/migrations/20260703_create_scorecard_sessions.sql`):
  one row per completed scorecard — five category scores, surfaced leak, revenue band,
  UTM/source/referrer, session id, timestamp. Email/Discord are attached to the same row
  after the capture step.
- `content_leads`: upserted by email at stage `scorecard_completed`, linked to
  `content_tracked_links` when a slug is resolvable from `ref`/`utm_content`.
- The audit CTA carries `sc_session`, `sc_leak`, and the UTM set into the application URL
  so the scorecard→audit stage joins in reporting.

### Webhooks (Zapier-compatible, preserved from the previous build)

```text
SCORECARD_WEBHOOK_URL=            # default destination for submissions + events
SCORECARD_RESULTS_WEBHOOK_URL=    # override for completed submissions only
SCORECARD_EVENT_WEBHOOK_URL=      # override for behavior events only
```

Submissions include flat fields (email, discordUsername, leakCategory, per-category
scores, revenue band, UTMs) plus nested answers and tracking context.

### GA4 (optional)

```text
NEXT_PUBLIC_GA_MEASUREMENT_ID=G-XXXXXXXXXX
```

## Deployment

Vercel, no special settings. The GitHub Pages workflow (`GITHUB_PAGES=true` static
export) still exists but API-backed tracking only runs on Vercel.

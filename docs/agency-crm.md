# Agency CRM

The CRM turns the output of `lead_pipeline/` into a sales process: stages, owners,
activity history, opportunities, clients and payment records. It is built *around* the
pipeline, not into it — the Python code is untouched and still runs standalone.

---

## The boundary

Two systems, one join key.

```
lead_pipeline (Python, SQLite, offline)          CRM (Next.js + Supabase Postgres)
─────────────────────────────────────            ─────────────────────────────────
discovers, enriches, scores            ──JSON──▶  lead_intelligence   (replica, read-only)
leads.id  ("1320d1738b0db4a0")            sync    crm_leads.external_lead_id  (UNIQUE)
                                                  ├─ contacts, activities, tasks
                                                  ├─ opportunities → proposals
                                                  └─ clients → contracts → payments
```

`leads.id` is a 16-character SHA-1 of the strongest identity the pipeline has — Google
place id, else domain, else normalised name plus locality. It is stable across re-scrapes,
which is what makes the sync idempotent.

**Why the research is copied rather than queried.** The pipeline's SQLite file lives on
whichever machine ran the scrape; a serverless CRM cannot reach it. `lead_intelligence` is
therefore a replica with exactly one writer — the sync, running as the service role. There
is no INSERT, UPDATE or DELETE policy on that table for any CRM user, so "the sync owns
this data" is enforced by row level security rather than by everyone remembering it.

That boundary is why the decision-maker the pipeline discovers
(`lead_intelligence.contact_name` / `contact_role` / `contact_source_url`) is *not* a
`contacts` row. `contacts` is CRM state — people your team added, verified and possibly
corrected — and a re-sync must never touch it. The discovered name is research: shown on
the lead page with the role and the page it was read from, and promoted to a real contact
by a human when it turns out to be right.

The inverse holds too: **the sync never writes CRM state.** `crm_leads` rows are
insert-only from the sync's point of view. A lead you moved to `won` stays `won` however
many times it is re-scraped.

---

## Setup

1. **Create the schema.** Apply every file in `supabase/migrations/` in filename order
   to your Supabase project (SQL editor, or `supabase db push`).

2. **Configure the app.** In `.env.local`:

   ```
   NEXT_PUBLIC_SUPABASE_URL=https://<project>.supabase.co
   NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key>
   SUPABASE_SERVICE_ROLE_KEY=<service role key>   # server-side only, never NEXT_PUBLIC
   ```

3. **Create a user.** Supabase dashboard → Authentication → Add user. A `profiles` row is
   created automatically by the `handle_new_auth_user` trigger, with role `sales`.

4. **Promote yourself to owner** (the first account has to be done by hand, since only an
   admin can change roles):

   ```sql
   update public.profiles set role = 'owner' where email = 'you@agency.com';
   ```

5. **Check it before you trust it.**

   ```bash
   npm run doctor
   ```

   Validates configuration, confirms all 18 tables exist and both migrations are
   applied, finds an admin account, and — most importantly — verifies that a
   signed-out request reads nothing. A misconfigured CRM and an empty one look
   identical in the browser, so guessing between them costs more than the check.

6. `npm run dev`, then sign in at `/login`.

---

## Deploying to production

**Vercel**, Node runtime. Do not set `GITHUB_PAGES=true` — the CRM is
server-rendered per request and cannot be statically exported; `npm run doctor`
fails the build target check if it finds it.

Environment variables, all three at Production scope:

| Variable | Scope | Notes |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | browser + server | Safe to expose |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | browser + server | Safe to expose; RLS is what protects the data |
| `SUPABASE_SERVICE_ROLE_KEY` | **server only** | Bypasses RLS entirely |
| `LEAD_SYNC_SECRET` | server only | Optional; the import route 503s until it is set |

The service-role key must never be given a `NEXT_PUBLIC_` name — that compiles
it into the browser bundle and hands every visitor full database access.
`npm run doctor` checks for exactly that and fails.

Run the preflight against production once deployed:

```bash
vercel env pull .env.production.local
env $(grep -v '^#' .env.production.local | xargs) npm run doctor
```

### Sessions

`src/middleware.ts` refreshes the Supabase access token on every CRM request and
redirects signed-out visitors to `/login?next=…`. Without it, tokens expire after
about an hour and users are silently logged out: Server Components cannot write
cookies, so nothing else in the App Router can persist a refreshed token.

It runs on the CRM paths and `/login` only. `POST /api/crm/sync-leads` is
deliberately excluded — it authenticates with a shared secret, not a session.

---

## Importing leads

Run the pipeline as usual, export JSON, then sync:

```bash
python lead_pipeline/pipeline.py --niche invisalign_dental_practices \
  --location "Newcastle upon Tyne" --radius 25 --format json --output leads.json

npm run sync:leads -- --file leads.json --min-score 55
```

Useful flags: `--dry-run` (parse and map, write nothing — prints the first mapped row),
`--limit n`, `--stage ready_for_outreach` for the stage new leads land in.

Re-running is safe and expected. A second run reports:

```
LEAD SYNC COMPLETE
  Received:            120
  CRM leads created:   14
  Already in CRM:      106 (stage and history preserved)
  Intelligence synced: 120
```

### Automating it later

`POST /api/crm/sync-leads/` accepts the same JSON document. Authenticate with the shared
secret in `LEAD_SYNC_SECRET`:

```bash
curl -X POST "$SITE/api/crm/sync-leads/?min_score=55" \
  -H "Authorization: Bearer $LEAD_SYNC_SECRET" \
  -H 'content-type: application/json' \
  --data @leads.json
```

The route returns 503 until `LEAD_SYNC_SECRET` is set — it fails closed rather than
defaulting open. Note the trailing slash: `trailingSlash: true` in `next.config.mjs` means
the unslashed path answers with a 308 redirect.

---

## Roles and permissions

| Role | Read | Write leads/activities | Manage clients & payments | Change roles |
| --- | --- | --- | --- | --- |
| `owner` | ✓ | ✓ | ✓ | ✓ |
| `admin` | ✓ | ✓ | ✓ | ✓ |
| `sales` | ✓ | ✓ | ✓ | — |
| `account_manager` | ✓ | ✓ | ✓ | — |
| `viewer` | ✓ | — | — | — |

Enforced by four SECURITY DEFINER helpers used in every policy: `crm_role_of()`,
`crm_is_member()`, `crm_is_admin()`, `crm_can_write()`. A deactivated profile
(`is_active = false`) is not a member, so revoking access is one column update.

Three tables have **no write policy at all**:

- `lead_intelligence` — written only by the sync.
- `payments` — written only by the (not yet built) Stripe webhook. The frontend must never
  be able to assert that money arrived.
- `pipeline_stage_history` — written only by a trigger, so the audit trail cannot be
  edited after the fact.

---

## Behaviour that lives in the database

Put in triggers rather than application code, so it holds no matter which client writes:

- **`record_pipeline_stage_change`** — every stage transition writes a
  `pipeline_stage_history` row and stamps the matching funnel timestamp
  (`first_contacted_at`, `first_replied_at`, `converted_at`). A no-op update writes
  nothing.
- **`halt_outreach_on_inbound_reply`** — logging an inbound activity stops any running
  outreach sequence and advances the lead to `replied`, but only from
  `qualified`/`ready_for_outreach`/`contacted`. A lead already at `proposal` or `won` never
  regresses.
- **`handle_new_auth_user`** — a new Supabase auth user gets a `profiles` row.
- **`set_updated_at`** — on every mutable table.

---

## Routes

| Route | Purpose |
| --- | --- |
| `/login` | Sign in (server action; no credentials in client JS) |
| `/dashboard` | Today's tasks, upcoming appointments, weighted pipeline, recent leads |
| `/leads` | Filterable list — stage, minimum score, company-name search |
| `/leads/[id]` | CRM state, business intelligence, contacts, activity timeline, stage history |
| `/pipeline` | Board, one column per active stage |
| `/tasks` | Open tasks, grouped overdue / scheduled / undated |
| `/calendar` | Upcoming appointments by day |
| `/opportunities` | Deals, contract value and weighted value |
| `/clients` | Accounts |
| `/clients/[id]` | Contracts, payments, activity |
| `/payments` | All invoices, read-only |

Every one is a server component reading through the session-scoped client, so RLS applies
to the page as well as to the API.

---

## Deliberately not built

Present in the schema so the data model does not need re-cutting later, but with no
implementation and no UI:

cold email sending · SMS · automated calling · voicemail drops · Google Calendar OAuth ·
Google Meet automation · Stripe payment processing · AI transcription · AI meeting
summaries · client portal · advanced analytics · an automated outreach engine.

The CRM records that a call happened; it does not place one. Nothing in it sends a message
to a lead.

---

## Tests

```bash
npm run verify      # typecheck + unit tests + build, in that order
npm run doctor      # configuration, schema and RLS against a live project

# schema assertions against a real Postgres 16
CRM_TEST_DATABASE_URL=postgres://postgres@localhost:5432/postgres npm run db:test
```

`supabase/tests/crm_schema_test.sql` runs 93 assertions covering structure, indexes on
every foreign key, trigger behaviour, cascade rules, and RLS enforced under actual role
impersonation — including that a viewer's INSERT is rejected and an anonymous request sees
nothing. It found two genuine schema bugs while being written; run it after any migration
change.

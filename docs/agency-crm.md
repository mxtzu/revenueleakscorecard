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

### What the UI can write

Full create/edit/delete: **contacts, tasks, appointments, opportunities, clients, notes,
contracts, proposals, documents, outreach sequences and steps**.
Create and edit are open to any writing role; **delete is admin-only**, matching
`crm_is_admin()` in RLS — so the delete control renders for owners and admins
only, rather than offering a button the database refuses.

Two derived fields are never entered by hand, because a second field that can
disagree with the first is a reporting bug waiting to happen:

- `tasks.completed_at` follows `status`
- `opportunities.won_at` / `lost_at` follow `stage` (and an existing date is kept
  when a closed deal is edited, so "won last March" does not drift to today)

Two more, added with contracts and proposals:

- `contracts.signed_at` follows the status. Expired and terminated keep the date
  — a contract that ran out was still signed — and only draft or sent clear it.
- `proposals` stamps `sent_at`, `viewed_at` and `accepted_at` cumulatively, so a
  proposal that was sent, then viewed, then accepted ends up with all three.
  Proposal versions and outreach step numbers are derived, not typed.

Wall-clock times entered in a form are interpreted in `Europe/London` unless the
record carries its own zone, as appointments do. The offset is looked up rather
than assumed: 14:00 in London is 14:00Z in January and 13:00Z in June.

### The sales workflow

Five transitions move a deal, and each one touches several tables at once:

| Action | Writes |
| --- | --- |
| Lead → Opportunity | `opportunities` + `crm_leads.pipeline_stage` + `activities` |
| Log a call | `activities` + `crm_leads.next_action` + `opportunities.next_action` + `tasks` |
| Proposal sent | `proposals` + `opportunities` + `crm_leads` + `activities` |
| Won → Client | `opportunities` + `clients` + `contracts` + `crm_leads` + `activities` |
| Lost | `opportunities` + `crm_leads` + `activities` |

**PostgREST cannot send a transaction.** Four sequential REST calls can fail
halfway and leave a won opportunity with no client, or a client whose lead is
still sitting in `sales_call`. So each transition is a single plpgsql function
in `20260818_sales_workflow.sql`, called through one `rpc()`
(`src/lib/crm/workflow.ts`) — it either happens completely or not at all.

Those functions are **SECURITY INVOKER**, so every statement inside is still
checked by the same RLS policies a direct write would hit. The transaction buys
atomicity, not privilege. As DEFINER they would hand every signed-in user the
ability to create clients.

Rules the database enforces, rather than the form:

- **Stages only move forward.** `crm_stage_rank()` ranks the ladder explicitly
  — the enum's own order would put `lost` above `won`. A late-logged discovery
  call cannot drag a lead back out of `negotiation`, and a closed lead is never
  silently reopened.
- **A lost deal needs a reason.** "Lost" with no reason is the least useful row
  a CRM can hold.
- **A lead with another live deal stays open** when one of its deals is lost.
- **A deal that already became a client cannot be marked lost** — that would
  leave the account with nothing behind it. It raises and says to cancel the
  client instead.
- **Winning twice returns the same client.** Double-submitting the form is safe.
- Workflow bookkeeping is logged as `direction = 'internal'`, so it cannot trip
  `halt_outreach_on_inbound_reply` and claim the lead replied. Marking a
  proposal sent logs `outbound`, because a document really did go out.

Creating an opportunity from `/opportunities` goes through the same transaction
as converting from a lead page. Two creation paths with different side effects
is how a board ends up disagreeing with the forecast, so there is no plain
`createOpportunity` in `mutations.ts` at all.

**Nothing here sends anything.** "Proposal sent" records that a human sent a
document; the CRM does not deliver it.

### The sales call workspace

`/leads/[id]/call` is a page to have the call from. The pipeline's findings are
on the left, arranged as things to say — strengths first, then the gaps that
are costing them money — and the notes, outcome and follow-up are on the right
in one form that saves as one transaction. Notes saved without the follow-up is
the exact failure a follow-up exists to prevent.

### Documents

Files live in a **private** Supabase Storage bucket (`crm-documents`), created by
`20260817_document_storage.sql`. Storage has its own RLS on `storage.objects`,
entirely separate from the table policies, and the three object policies mirror
the CRM's exactly: read for members, write for writers, delete for admins.
Getting the row policy right and leaving the object policy open is the classic
way to leak files while the database looks locked down.

Pages link to `/api/crm/documents/[id]`, which resolves the row under the
caller's session and redirects to a 60-second signed URL. Putting the signed URL
in the page instead would leave a working credential in the HTML, in browser
history and in any copied link.

Uploads are capped at 25 MB and executables, scripts, HTML and SVG are refused —
a file served from a signed URL is a stored-XSS vector aimed at whoever opens
it.

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
| `/leads/[id]` | CRM state, intelligence, timeline + CRUD for contacts, tasks, appointments, opportunities, notes |
| `/leads/[id]/call` | Sales call workspace — talking points, call notes, follow-up and task in one save |
| `/pipeline` | Board, one column per active stage |
| `/tasks` | Open tasks grouped by urgency; create, edit, complete, reopen, delete |
| `/calendar` | Appointments by day; book, edit, change status, delete |
| `/opportunities` | Deals with value totals; create, edit, delete, manage proposals, mark sent, win into a client, mark lost |
| `/outreach` | Sequence and step templates. Writes templates only — nothing sends |
| `/clients` | Accounts; create |
| `/clients/[id]` | Account edit, contracts, documents, payments, notes, tasks |
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

`/outreach` is the edge of this line and worth being precise about. You can write
sequences, order their steps, set channels and delays, and draft the templates —
that is the structure a sending engine would read, built now so the schema does
not need re-cutting later. There is no enrol control and no send. `lead_outreach`
shows enrolment state on a lead's page because
`halt_outreach_on_inbound_reply` writes to it, not because anything here starts
a sequence.

---

## Tests

```bash
npm run verify      # typecheck + unit tests + build, in that order
npm run doctor      # configuration, schema and RLS against a live project

# schema assertions against a real Postgres 16
CRM_TEST_DATABASE_URL=postgres://postgres@localhost:5432/postgres npm run db:test
```

`supabase/tests/crm_schema_test.sql` covers structure, indexes on every foreign key,
trigger behaviour, cascade rules, and RLS enforced under actual role impersonation —
including that a viewer's INSERT is rejected and an anonymous request sees nothing. It
found two genuine schema bugs while being written.

`supabase/tests/sales_workflow_test.sql` covers the transition functions, all of it
under an impersonated `authenticated` role because the functions are SECURITY INVOKER
and running them as superuser would test something the application never does. It
asserts forward-only stage movement, idempotent winning, the refusals, that a failed
conversion leaves nothing behind, that a viewer is refused with
`insufficient_privilege`, that `anon` holds no EXECUTE, and that none of the functions
is SECURITY DEFINER.

Run both after any migration change.

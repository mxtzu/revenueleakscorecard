# Deploying

Vercel in front, Supabase behind. Everything below assumes a fresh production
project, not a promoted development one — the CRM's development database has
test Stripe objects and scraped leads in it, and neither belongs in production.

---

## Order

The order matters in two places: the schema has to exist before the app can
start, and the domain has to exist before the OAuth and webhook URLs can be
registered.

1. Supabase project
2. Schema
3. Vercel project and environment variables
4. Domain
5. Third-party callbacks (Google, Stripe, Resend, Twilio) — these need the
   final domain
6. Preflight, then the first admin account
7. Turn outreach on, last and deliberately

---

## 1. Supabase

Create a project in the region your customers are in — `eu-west-2` (London) for
a UK agency. Cross-region latency is added to every query on every page.

**Pick a paid plan if this holds real client data.** The free tier has no
point-in-time recovery and pauses after a week of inactivity, which for a CRM
means the sales team arrives on Monday to a dead application.

Then, in project settings:

- **Database → Connection pooling**: leave the pooler on. Serverless functions
  open a connection per invocation and a Postgres instance will not survive that
  without it.
- **Auth → Providers**: email only. Nothing here needs social login, and each
  provider added is another way in.
- **Auth → URL configuration**: set the site URL to the production domain once
  it exists.
- **Settings → API**: copy the URL, the `anon` key and the `service_role` key.

---

## 2. Schema

Apply every file in `supabase/migrations/` in filename order. They are ordinary
SQL and can go through the dashboard's SQL editor, but the CLI is less
error-prone:

```bash
supabase link --project-ref <ref>
supabase db push
```

Then verify against a real Postgres before trusting it:

```bash
CRM_TEST_DATABASE_URL=postgres://postgres@localhost:5432/postgres npm run db:test
```

That runs 285+ assertions against a scratch database — RLS under real role
impersonation, every trigger, every cascade. It will not touch production, and
it is the difference between "the migrations applied" and "the migrations did
what they say".

---

## 3. Vercel

Framework preset **Next.js**, Node runtime, region `lhr1` (see `vercel.json`).

**Do not set `GITHUB_PAGES`.** The marketing site can be statically exported;
the CRM cannot, and `npm run preflight` fails the build if it finds the flag.

### Environment variables

Everything is in `.env.example` with a note on each. The rule that matters:

> A `NEXT_PUBLIC_` prefix compiles the value into the JavaScript every visitor
> downloads. `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
> `NEXT_PUBLIC_SITE_URL` and `NEXT_PUBLIC_SENTRY_DSN` belong there. **Nothing
> else does.**

`npm run preflight` refuses to build if a secret carries that prefix, and also
catches the mistake in the other direction: pasting the `service_role` key into
the anon slot. That one is silent — the app works perfectly and row level
security stops applying to every browser in the world — so it is checked by
reading the `role` claim out of the JWT rather than by trusting the variable
name.

Run it against production before and after deploying:

```bash
vercel env pull .env.production.local
npm run preflight -- --env=.env.production.local
```

---

## 4. Domain

Add the domain in Vercel, point the DNS, let the certificate issue.

Then set `NEXT_PUBLIC_SITE_URL` to it — **not** to the `*.vercel.app` URL.
Unsubscribe links are built from that variable and have to keep working for as
long as the emails they are in exist. A link pointing at a preview deployment
is a link that 404s in six weeks, which is both a bad experience and a
compliance problem.

Once the domain exists, register these callbacks:

| Service | URL |
| --- | --- |
| Google OAuth redirect | `https://<domain>/api/crm/calendar/callback` |
| Google Calendar push | `https://<domain>/api/crm/calendar/webhook` |
| Stripe webhook | `https://<domain>/api/crm/stripe/webhook` |
| Resend webhook | `https://<domain>/api/crm/outreach/email` |
| Twilio inbound SMS | `https://<domain>/api/crm/outreach/sms` |

Set `TWILIO_WEBHOOK_URL` to the exact URL you gave Twilio. Twilio signs the URL
from its own console, so behind a proxy that rewrites the host, verification
fails unless the public URL is stated rather than inferred from a header an
attacker controls.

---

## 5. Scheduled work

See `docs/vercel-crons.md`. The short version: both cron endpoints are
`POST`-only and secret-guarded, so they need an external scheduler or a small
forwarder — a Vercel cron sends `GET` and will not drive them as-is. That is
deliberate; a `GET` that sends email can be triggered by a link prefetch.

---

## 6. First run

```bash
npm run doctor
```

Checks configuration, confirms every table exists, finds an admin account, and —
most usefully — verifies that a signed-out request reads nothing. A misconfigured
CRM and an empty one look identical in a browser.

Create the first user in the Supabase dashboard, then promote them by hand:

```sql
update public.profiles set role = 'owner' where email = 'you@agency.com';
```

---

## 7. Error monitoring

Optional, and worth doing before anything runs unattended.

Set `SENTRY_DSN` (server) and `NEXT_PUBLIC_SENTRY_DSN` (browser). Without them
the SDK is inert and errors go to the Vercel runtime log as structured JSON
lines tagged `[crm]`.

Two decisions baked in:

- **`sendDefaultPii` is off and session replay is disabled.** Every screen in
  this application is full of other people's business data. `reportError()`
  scrubs anything attached deliberately — credentials redacted, addresses masked
  to `d***@domain` so the domain stays diagnosable and the person does not.
- **Reporting is wired into the unattended paths only** — the cron endpoints and
  the webhooks. A route handler returns its error to a caller who can see it; a
  cron run has nobody watching, and an engine that has been throwing for a
  fortnight looks exactly like a quiet week.

For source maps, add `SENTRY_ORG`, `SENTRY_PROJECT` and `SENTRY_AUTH_TOKEN`.
Without the token, upload is skipped rather than warned about on every build.

---

## 8. Backups

**Supabase is the primary backup.** Daily snapshots on any paid plan;
point-in-time recovery on Pro and above. Turn PITR on — it is the only thing
that recovers from "someone deleted the wrong client at 14:32", which is a far
more likely disaster than losing the cluster.

`npm run backup` is the secondary, for the two things a managed snapshot does
not give you:

```bash
npm run backup -- --out backups/
```

- **Something you hold.** A backup that only exists inside the account it is
  protecting is not much of a backup.
- **Something you can read.** "Which invoices existed last Tuesday" is
  answerable from a JSON file in seconds and from a cluster snapshot in an hour.

It runs with the service role and deliberately excludes `calendar_credentials`
(OAuth tokens, encrypted with a key the file would not contain — useless to a
restore, dangerous in a backup directory) and the webhook ledgers
(reconstructible from the providers).

**Treat the output like a database dump.** It contains every lead, every
contact and every message ever sent. Encrypted storage, off this machine, and
not in the repository — `backups/` is gitignored.

### Restoring

Test this before you need it, on a branch database rather than production:

1. Supabase dashboard → Database → Backups → restore, or PITR to a timestamp.
2. Re-apply any migration created after the restore point.
3. `npm run db:test` against the restored database.
4. Reconnect Google Calendar per user — the tokens were not in the backup and
   the encryption key may have rotated.

---

## What deployment does not turn on

Outreach. `outreach_settings.sending_enabled` defaults to `false` and only an
owner or admin can change it, from `/outreach`. Deploying, configuring Resend
and pointing a scheduler at the run endpoint all leave it off.

Before switching it on: send one message to yourself, click the unsubscribe
link in it, then reply to a second one and confirm the sequence stopped. Those
three checks exercise everything that matters and take two minutes.

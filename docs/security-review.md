# Security review

Done before the first production deploy, over the whole application rather than
the last diff. What follows is what was found, what was changed, and what was
deliberately left.

Method: enumerate every way data leaves the system (pages, API routes, the four
third-party integrations, the outbound engine) and every way it can be reached
(anon key, authenticated session, service role, unauthenticated endpoint), then
check each pair. Plus a direct audit of the database — RLS coverage and function
grants — because that is where enforcement actually lives.

---

## Findings

### 1. `crm_is_suppressed()` was callable by `anon` — fixed

**Severity: moderate. Information disclosure.**

`crm_is_suppressed(email, phone)` is `SECURITY DEFINER` so the send path can
consult the do-not-contact list without granting anybody a readable copy of it.
Postgres grants `EXECUTE` on a new function to `PUBLIC` by default, and `PUBLIC`
includes `anon` — the role behind the anon key, which is in the browser bundle
by design.

So anyone at all could ask:

```sql
select public.crm_is_suppressed('someone@somewhere.test', null);
```

and get a definitive yes or no, revealing that this agency holds a record of
that person and that they unsubscribed, bounced or complained.

Nothing drew attention to it because the function is not referenced by any RLS
policy — the grant was simply never narrowed.

Fixed in `20260822_harden_grants.sql`: revoked from `PUBLIC`, granted to
`authenticated` and `service_role`. Asserted in `outreach_test.sql`, including
that an anonymous call is actually refused rather than merely ungranted.

`crm_role_of()` was deliberately **not** narrowed. Every RLS policy calls it
through `crm_is_member()`, and a signed-out request that failed with "permission
denied for function" instead of returning zero rows would be a worse answer than
the one it gives now.

### 2. Open redirect via backslash — fixed

**Severity: moderate. Phishing.**

Six copies of the same guard existed, one per server-action file, plus a
seventh on the login page:

```ts
if (!value.startsWith('/') || value.startsWith('//')) return fallback;
```

That rejects `//evil.example` but not `/\evil.example`. Browsers normalise a
backslash to a forward slash while parsing the authority, so the second form
navigates off-site just the same — and tabs and newlines are stripped during
parsing, giving `/\tevil.example` as another spelling.

Consequence: a link to `https://crm.youragency.com/login?next=/\evil.example`
lands on a real login form on the real domain and then hands the user to an
attacker.

Fixed by replacing all seven with `src/lib/crm/redirects.ts`, which rejects
backslashes and control characters as well. The duplication was itself the
finding — seven copies is how one ends up different from the others.

### 3. No security headers — fixed

**Severity: moderate.**

The application sent none. Three consequences that were concrete rather than
theoretical:

- **Clickjacking.** Every destructive control is a plain form button. Framed on
  an attacker's page, "delete this client" is one invisible click.
- **Referrer leakage.** Lead pages link out to the prospect's own website. With
  the default policy the full CRM URL, including the internal lead id, arrived
  in a third party's access log.
- No HSTS, so the first request of a session was downgradeable.

Fixed in `next.config.mjs`: `X-Frame-Options: DENY`, `frame-ancestors 'none'`,
`Referrer-Policy: strict-origin-when-cross-origin`, HSTS with a two-year
max-age, `nosniff`, a restrictive `Permissions-Policy`, and a CSP that limits
`connect-src` to Supabase and Sentry and `form-action` to this origin.

The CSP keeps `'unsafe-inline'` for scripts. Next injects an inline hydration
bootstrap, and a nonce-based policy needs middleware rewriting every response —
worth doing, not done here. The policy is a hardening layer, not an XSS
backstop; React's escaping is what actually prevents injection, and the CSP
narrows where anything that slipped past it could send data.

### 4. Manual HTML escaping in the unsubscribe route — fixed

**Severity: low. Defence in depth.**

`/api/crm/outreach/unsubscribe` builds raw HTML rather than JSX — the one place
without React's automatic escaping — and interpolated the query-string token
into an attribute having stripped only `"`.

Not exploitable as written: without a quote character the value cannot escape a
double-quoted attribute. But "not exploitable as written" is a property that
survives exactly until the next edit. Replaced with a real `escapeHtml`.

### 5. Scrubber bypass in error reporting — fixed during development

**Severity: low, and caught before it shipped.**

The first version of `scrub()` matched a key against a list of personal field
names and, on a match, masked the value *if it was a string* — otherwise
returning it untouched. `recipients` matches `recipient`, so
`{ recipients: [{ email: '...' }] }` was passed through unscrubbed and every
address inside would have been sent to Sentry.

Found by a test written for the nested case. Fixed by recursing whenever the
value is not a string.

---

## Checked and found sound

**Row level security.** Every table in `public` has RLS enabled — verified by
query, not by reading the migrations. The tables that must not be writable from
a browser have no write policy at all rather than a restrictive one:
`lead_intelligence`, `payments`, `subscriptions`, `pipeline_stage_history`,
`outreach_messages`, `inbound_messages`. `calendar_credentials`,
`calendar_deletions`, `stripe_events` and `provider_events` have no policies
whatsoever, so they are service-role only. There are assertions for each,
including one that an *owner* attempting `update payments set status = 'paid'`
changes nothing.

**Secrets.** No secret carries a `NEXT_PUBLIC_` prefix; `npm run preflight`
fails the build if one ever does, and separately detects a `service_role` JWT
pasted into the anon slot by reading its `role` claim. Google OAuth tokens are
AES-256-GCM sealed before storage, so a database backup alone is not a set of
live credentials.

**Webhook authentication.** Stripe uses the SDK's `constructEvent`. Resend
(Svix) and Twilio are hand-implemented and tested against a tampered payload, a
wrong secret and an expired timestamp. All three reject unsigned requests
outright. The three shared-secret endpoints compare in constant time and fail
closed — 503 when the secret is unset, never open.

**Injection.** No `dangerouslySetInnerHTML` anywhere. Every query goes through
PostgREST's parameter binding; the one place user input reaches a `LIKE`
pattern is escaped. Uploaded filenames are sanitised and path traversal is
tested. Executables, scripts, HTML and SVG are refused on upload, because a
file served from a signed URL is a stored-XSS vector aimed at whoever opens it.

**SSRF.** The URL fields on documents and contracts are stored and rendered as
links, never fetched server-side, and are restricted to `http`/`https`.

**Authorisation.** Every mutating server action re-checks the role at write
time rather than trusting what the page rendered. Where the service-role client
is used — billing, calendar, outreach — the ownership check above it is
load-bearing rather than decorative, because RLS is not standing behind it, and
each is commented as such.

---

## Accepted, not fixed

**No rate limiting on the unauthenticated endpoints.** The unsubscribe route
takes a 48-hex-character token; brute force is infeasible. The webhooks require
a valid signature. Login is rate-limited by Supabase. Adding a limiter would
mean adding shared state to a serverless deployment for no current benefit —
revisit if the app ever gets a public signup form.

**CSP allows inline scripts.** See finding 3.

**`crm_role_of()` remains executable by `anon`.** See finding 1.

**Phone-number suppression matching is naive.** `+44 (0)7700 900222` does not
match `+447700900222` — stripping punctuation leaves the trunk zero, making it a
different number. Asserted as current behaviour rather than papered over. It
matters only for SMS, and only for numbers written with a bracketed zero; a real
fix needs a phone-number library.

**No audit log of reads.** Who *viewed* a lead is not recorded, only who changed
one. Fine for a five-person agency, not for a regulated one.

---

## Before going live

1. `npm run preflight -- --env=.env.production.local`
2. `npm run doctor` against production — it verifies a signed-out request reads
   nothing, which is the single most valuable check here
3. Confirm the response headers on the live domain include HSTS and
   `X-Frame-Options`
4. Turn PITR on in Supabase
5. Rotate any key that has been in a chat window, a screenshot or a terminal
   history during setup

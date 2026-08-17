# Scheduled work

`vercel.json` declares two crons. Both hit endpoints that already refuse
unauthenticated callers, and both need a secret before they do anything.

| Path | Schedule | Needs |
| --- | --- | --- |
| `/api/crm/outreach/run` | every 15 min, 09:00–17:59 Mon–Fri (UTC) | `OUTREACH_RUN_SECRET` |
| `/api/crm/calendar/sync` | every 20 min | `CALENDAR_SYNC_SECRET` |

## Two things about Vercel crons that bite

**They send `GET`, and both of these routes are `POST`-only.** That is
deliberate — a `GET` that sends email could be triggered by a link prefetch —
so a Vercel cron cannot drive them directly. Use one of:

- **Vercel Cron + a tiny forwarder.** Add a `GET` route that checks
  `request.headers.get('authorization') === 'Bearer ' + process.env.CRON_SECRET`
  (Vercel sets that header from the project's `CRON_SECRET`) and then calls the
  `POST` handler internally.
- **An external scheduler** — GitHub Actions, cron-job.org, Upstash QStash —
  posting with the bearer token. This is what the endpoints were built for and
  needs no extra code.

GitHub Actions example:

```yaml
name: outreach
on:
  schedule: [{ cron: '*/15 9-17 * * 1-5' }]
jobs:
  run:
    runs-on: ubuntu-latest
    steps:
      - run: |
          curl -sS -X POST "$SITE/api/crm/outreach/run" \
            -H "Authorization: Bearer $SECRET" --fail-with-body
        env:
          SITE: ${{ secrets.SITE_URL }}
          SECRET: ${{ secrets.OUTREACH_RUN_SECRET }}
```

**The cron schedule is UTC.** The 09:00–17:59 window above is UTC, and the
engine applies its *own* window from `outreach_settings.timezone` on top. In
British Summer Time the cron therefore starts firing at 10:00 local — harmless,
because the engine simply finds nothing due until its own window opens, but
worth knowing before wondering why nothing went out at nine. Widening the cron
to `8-18` and letting the engine decide is the simpler arrangement.

## The region

`lhr1` (London). Both the Supabase project and the customers are in the UK, and
a function in Washington adds a round trip to every query for no benefit. Change
it to match wherever the database actually lives.

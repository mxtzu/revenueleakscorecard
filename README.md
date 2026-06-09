# ASCEND Roblox Revenue Leak Scorecard

A premium front-end diagnostic for post-traction Roblox studios to identify lifecycle revenue leaks across acquisition, activation, monetisation, measurement, and compounding.

Core promise: increase the value of every player before spending more to acquire the next one.

## What It Includes

- 15-question scorecard across five revenue leak categories
- 0-4 scoring model with percentage result bands
- Email gate before the full breakdown
- Category diagnosis cards and top two weakest categories
- CTA flow for a Revenue Leak Audit and 30/60/90 Revenue Roadmap
- Event tracking for starts, answers, completions, email unlocks, result views, prints, restarts, and CTA clicks
- Server capture route for scorecard submissions and optional webhook forwarding
- Static export configuration for GitHub Pages

## Local Development

```powershell
pnpm install
pnpm dev
```

Open `http://localhost:3000`.

## Tracking Setup

The app works without any tracking credentials, but persistent lead/result capture needs at least one destination configured in Vercel.

Add these environment variables in Vercel under Project Settings -> Environment Variables:

```text
SCORECARD_WEBHOOK_URL=https://your-zapier-make-airtable-or-crm-webhook
NEXT_PUBLIC_GA_MEASUREMENT_ID=G-XXXXXXXXXX
```

`SCORECARD_WEBHOOK_URL` receives both behavior events and completed scorecard submissions. If you want separate destinations, use:

```text
SCORECARD_RESULTS_WEBHOOK_URL=https://your-lead-results-webhook
SCORECARD_EVENT_WEBHOOK_URL=https://your-behavior-events-webhook
```

Completed scorecard submissions include email, total score, result band, weakest categories, category scores, answers, UTM parameters, referrer, page URL, and basic request context. Behavior events include scorecard starts, question answers, completions, email submissions, results views, print clicks, restarts, audit CTA clicks, and roadmap CTA clicks.

Google Analytics 4 is optional. If `NEXT_PUBLIC_GA_MEASUREMENT_ID` is set, the same key events are also sent as GA4 browser events.

## Deployment

This repo includes a GitHub Pages workflow at `.github/workflows/deploy-pages.yml`.

After the repository is public and GitHub Pages is enabled with the GitHub Actions source, pushes to `main` will build and deploy the static site.

For Vercel, no special build settings are required. The app uses Vercel server routes for scorecard capture unless the GitHub Pages workflow sets `GITHUB_PAGES=true`.

## Integration TODOs

- Add the ASCEND webhook destination or CRM endpoint in Vercel.
- Connect the 30/60/90 roadmap CTA to a dedicated lead magnet or CRM sequence if needed.

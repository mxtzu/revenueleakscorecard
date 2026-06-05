# ASCEND Roblox Revenue Leak Scorecard

A premium front-end diagnostic for post-traction Roblox studios to identify lifecycle revenue leaks across acquisition, activation, monetisation, measurement, and compounding.

Core promise: increase the value of every player before spending more to acquire the next one.

## What It Includes

- 15-question scorecard across five revenue leak categories
- 0-4 scoring model with percentage result bands
- Email gate before the full breakdown
- Category diagnosis cards and top two weakest categories
- CTA flow for a Revenue Leak Audit and 30/60/90 Revenue Roadmap
- Static export configuration for GitHub Pages

## Local Development

```powershell
pnpm install
pnpm dev
```

Open `http://localhost:3000`.

## Deployment

This repo includes a GitHub Pages workflow at `.github/workflows/deploy-pages.yml`.

After the repository is public and GitHub Pages is enabled with the GitHub Actions source, pushes to `main` will build and deploy the static site.

## Integration TODOs

- Replace local-only email capture with ASCEND's CRM or email provider.
- Replace mailto CTA fallbacks with the booking calendar and roadmap download flow.

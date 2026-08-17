import { withSentryConfig } from "@sentry/nextjs";

const isGitHubPages = process.env.GITHUB_PAGES === "true";
const repoPath = "/revenueleakscorecard";

/**
 * Security headers.
 *
 * The CRM had none before Sprint 7, which mattered in three specific ways
 * rather than as a general principle:
 *
 *   CLICKJACKING — every destructive control in this app is a plain form
 *   button. Framed on an attacker's page, "delete this client" is one
 *   invisible click.
 *
 *   REFERRER LEAKAGE — lead pages link out to the prospect's own website. With
 *   the default policy the full CRM URL, including the lead's internal id,
 *   travels in the Referer header to a third party's access log.
 *
 *   MIME SNIFFING — uploaded documents are served from Supabase's signed URLs
 *   rather than this origin, but the header costs nothing and closes the
 *   category.
 *
 * The CSP is deliberately not `unsafe-inline`-free: Next injects inline
 * bootstrap scripts and styled-jsx, and a nonce-based policy needs middleware
 * to rewrite every response. That is worth doing, and it is not done here — the
 * policy below is honest about being a hardening layer rather than an XSS
 * backstop. React's escaping is what actually prevents injection; this narrows
 * where anything that slipped through could send data.
 */
const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    // No feature here needs a camera, a microphone or a location.
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()"
  },
  {
    // Two years, subdomains included. Only meaningful over HTTPS, which
    // production is; browsers ignore it on http://localhost.
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload"
  },
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      // Next's hydration bootstrap is inline. eval is needed by the dev
      // overlay only, and is not permitted here.
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
      "font-src 'self' data:",
      // Supabase (REST, auth, storage, realtime) and Sentry ingest. Anything
      // else the browser tries to reach is a bug or an exfiltration attempt.
      "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://*.ingest.sentry.io",
      // Signed document URLs are same-origin redirects; nothing embeds a frame.
      "frame-src 'none'",
      "frame-ancestors 'none'",
      "object-src 'none'",
      "base-uri 'self'",
      // Forms post to this origin only. Stops an injected form from
      // exfiltrating a CSRF-protected action's fields.
      "form-action 'self'",
      "upgrade-insecure-requests"
    ].join("; ")
  }
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: isGitHubPages ? "export" : undefined,
  trailingSlash: true,
  basePath: isGitHubPages ? repoPath : "",
  assetPrefix: isGitHubPages ? `${repoPath}/` : undefined,
  images: {
    unoptimized: true
  },
  // Next 14 ignores instrumentation.ts entirely without this. On 15+ the hook
  // is stable and the flag is a no-op.
  experimental: {
    instrumentationHook: true
  },
  // `headers()` is unavailable in a static export, and the CRM cannot be
  // statically exported anyway — `npm run preflight` fails on GITHUB_PAGES.
  ...(isGitHubPages
    ? {}
    : {
        async headers() {
          return [{ source: "/:path*", headers: securityHeaders }];
        }
      })
};

/**
 * Sentry wraps the config to inject the browser SDK and, when a token is
 * present, upload source maps.
 *
 * Applied unconditionally because it is inert without a DSN, and skipping it
 * when one is absent would mean the production build differs structurally from
 * every build that was tested.
 */
export default withSentryConfig(nextConfig, {
  silent: !process.env.CI,
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  // Without an auth token there is nothing to upload; saying so beats a build
  // log full of warnings about a step that was never going to run.
  sourcemaps: { disable: !process.env.SENTRY_AUTH_TOKEN },
  // Routes the browser SDK's requests through this origin, so an ad blocker
  // does not silently discard every error report.
  tunnelRoute: '/monitoring',
  disableLogger: true
});

-- Per-session scorecard results for the ASCEND Revenue Leak Scorecard.
-- Joins into the existing funnel family:
--   session_id        -> content_link_clicks.session_id (when the redirect passes it through)
--   tracked_link_slug -> content_tracked_links.slug
--   email             -> content_leads.email
create table public.scorecard_sessions (
  id uuid primary key default gen_random_uuid(),
  session_id text,
  tracked_link_slug text,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  utm_content text,
  utm_term text,
  referrer text,
  landing_page text,
  revenue_band text,
  score_acquisition smallint,
  score_activation smallint,
  score_monetization smallint,
  score_measurement smallint,
  score_compounding smallint,
  total_score smallint,
  leak_category text,
  answers jsonb,
  email text,
  discord_username text,
  completed_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index scorecard_sessions_session_id_idx on public.scorecard_sessions (session_id);
create index scorecard_sessions_email_idx on public.scorecard_sessions (email);
create index scorecard_sessions_completed_at_idx on public.scorecard_sessions (completed_at);

-- Service-role writes only; no client-facing policies.
alter table public.scorecard_sessions enable row level security;

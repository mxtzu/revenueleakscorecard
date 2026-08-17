-- Named business contact discovered by lead_pipeline.
--
-- The pipeline now reads the decision-maker a business publishes about itself
-- (a "Meet the team" page, a director in structured data) and records the role
-- that justified it plus the page it came from.
--
-- These live on lead_intelligence, not on `contacts`. `contacts` is CRM state -
-- people your team has added, verified and possibly corrected - and the sync
-- must never write it. This is research: read-only, refreshed on every sync,
-- and a starting point for a human to promote into a real contact record.
--
-- Safe to re-run.

alter table public.lead_intelligence
  add column if not exists contact_name       text,
  add column if not exists contact_role       text,
  add column if not exists contact_source_url text;

comment on column public.lead_intelligence.contact_name is
  'Decision-maker published on the company website. Never inferred: recorded '
  'only where the page stated a business role alongside the name.';
comment on column public.lead_intelligence.contact_role is
  'The published role that justified recording the name, canonicalised by the '
  'pipeline (e.g. "Managing Director").';
comment on column public.lead_intelligence.contact_source_url is
  'The page the name and role were read from, so the claim can be checked.';

-- Finding the leads worth a personalised approach is a normal working filter.
create index if not exists lead_intelligence_contact_name_idx
  on public.lead_intelligence (contact_name)
  where contact_name is not null;

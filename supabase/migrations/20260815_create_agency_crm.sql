-- ============================================================================
-- Agency CRM / Agency OS foundation
-- ============================================================================
-- Sits AROUND the existing Python lead intelligence engine (lead_pipeline/),
-- which remains the system of record for scraping, enrichment and scoring.
--
--   lead_pipeline (Python + SQLite)      this schema (Postgres)
--   ------------------------------      ----------------------------------
--   discover / dedupe / enrich           outreach -> reply -> appointment
--   website + advertising analysis       -> opportunity -> won -> client
--   score / qualify                      -> contract -> payment
--
-- The join between the two is crm_leads.external_lead_id, which holds
-- lead_pipeline's leads.id (a 16-char SHA-1 prefix derived from
-- place_id > domain > normalized_name+locality+niche, stable across runs).
--
-- Two rules this schema enforces structurally rather than by convention:
--
--   1. lead_intelligence is a READ-ONLY replica of pipeline output. It has no
--      user-facing write policies, so only the service-role sync can populate
--      it. CRM users can never edit scraped intelligence.
--   2. crm_leads holds ONLY sales state. A re-sync updates intelligence and
--      never touches pipeline_stage, owner_id or any downstream record.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
create type crm_role as enum ('owner', 'admin', 'sales', 'account_manager', 'viewer');

create type crm_pipeline_stage as enum (
  'qualified',
  'ready_for_outreach',
  'contacted',
  'replied',
  'appointment_booked',
  'sales_call',
  'proposal',
  'negotiation',
  'won',
  'lost',
  'disqualified',
  'do_not_contact'
);

create type crm_activity_type as enum (
  'email', 'call', 'sms', 'voicemail', 'meeting', 'note',
  'task', 'status_change', 'proposal', 'payment', 'other'
);

create type crm_activity_direction as enum ('inbound', 'outbound', 'internal');

create type crm_outreach_channel as enum ('email', 'call', 'sms', 'voicemail', 'linkedin', 'other');

create type crm_outreach_status as enum (
  'not_started', 'active', 'paused', 'completed', 'stopped', 'replied'
);

create type crm_task_status as enum ('pending', 'in_progress', 'completed', 'cancelled');
create type crm_task_priority as enum ('low', 'normal', 'high', 'urgent');

create type crm_appointment_status as enum (
  'scheduled', 'confirmed', 'completed', 'no_show', 'cancelled', 'rescheduled'
);

create type crm_opportunity_stage as enum (
  'discovery', 'sales_call', 'proposal', 'negotiation', 'won', 'lost'
);

create type crm_proposal_status as enum (
  'draft', 'sent', 'viewed', 'accepted', 'rejected', 'expired'
);

create type crm_client_status as enum ('onboarding', 'active', 'paused', 'cancelled', 'churned');
create type crm_contract_status as enum ('draft', 'sent', 'signed', 'active', 'expired', 'terminated');

create type crm_payment_status as enum (
  'pending', 'paid', 'failed', 'overdue', 'refunded', 'cancelled'
);

-- ---------------------------------------------------------------------------
-- updated_at: one function, reused by every table that has the column.
-- Enforced in the database so it cannot be forgotten by a caller.
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- profiles: role metadata for auth.users.
-- Roles live here, not scattered through the application.
-- ---------------------------------------------------------------------------
create table public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text,
  full_name   text,
  role        crm_role not null default 'viewer',
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index profiles_role_idx on public.profiles (role) where is_active;

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- Role helpers. SECURITY DEFINER so policies can read profiles without
-- recursing through profiles' own RLS.
create or replace function public.crm_role_of(uid uuid)
returns crm_role
language sql
stable
security definer
set search_path = public
as $$
  select role from public.profiles where id = uid and is_active;
$$;

create or replace function public.crm_is_member()
returns boolean
language sql
stable
as $$
  select public.crm_role_of(auth.uid()) is not null;
$$;

create or replace function public.crm_is_admin()
returns boolean
language sql
stable
as $$
  -- coalesce: crm_role_of() is NULL for an anonymous or deactivated user, and
  -- `NULL in (...)` is NULL, not false. RLS treats NULL as deny, but a boolean
  -- helper that can return NULL is a trap for any other caller.
  select coalesce(public.crm_role_of(auth.uid()) in ('owner', 'admin'), false);
$$;

-- Everyone who may mutate CRM records. Viewers are read-only.
create or replace function public.crm_can_write()
returns boolean
language sql
stable
as $$
  select coalesce(
    public.crm_role_of(auth.uid()) in ('owner', 'admin', 'sales', 'account_manager'), false);
$$;

-- ---------------------------------------------------------------------------
-- crm_leads: sales state for a lead. NO intelligence fields.
-- ---------------------------------------------------------------------------
create table public.crm_leads (
  id                       uuid primary key default gen_random_uuid(),
  -- lead_pipeline leads.id. UNIQUE is what makes the sync idempotent.
  external_lead_id         text not null unique,
  pipeline_stage           crm_pipeline_stage not null default 'qualified',
  owner_id                 uuid references public.profiles(id) on delete set null,
  next_action              text,
  next_action_at           timestamptz,
  loss_reason              text,
  disqualification_reason  text,
  first_contacted_at       timestamptz,
  first_replied_at         timestamptz,
  converted_at             timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

create index crm_leads_pipeline_stage_idx on public.crm_leads (pipeline_stage);
create index crm_leads_owner_id_idx        on public.crm_leads (owner_id);
create index crm_leads_next_action_at_idx  on public.crm_leads (next_action_at)
  where next_action_at is not null;
create index crm_leads_updated_at_idx      on public.crm_leads (updated_at desc);

create trigger crm_leads_set_updated_at
  before update on public.crm_leads
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- lead_intelligence: read-only replica of lead_pipeline output.
--
-- The pipeline's SQLite database is not reachable from the web app, so the
-- CRM needs the intelligence in Postgres to render it. Keeping it in its own
-- table (rather than as columns on crm_leads) means there is exactly one
-- writer - the service-role sync - and no user-facing write policy exists.
-- ---------------------------------------------------------------------------
create table public.lead_intelligence (
  crm_lead_id                uuid primary key references public.crm_leads(id) on delete cascade,
  external_lead_id           text not null unique,

  -- company
  company_name               text not null,
  trading_name               text,
  legal_name                 text,
  niche                      text,
  sub_niche                  text,
  description                text,

  -- contact / location (as discovered; CRM contacts live in `contacts`)
  website                    text,
  domain                     text,
  business_phone             text,
  business_email             text,
  address                    text,
  city                       text,
  postcode                   text,
  region                     text,
  country                    text,
  latitude                   double precision,
  longitude                  double precision,

  -- online presence
  google_maps_url            text,
  facebook_url               text,
  instagram_url              text,
  linkedin_url               text,
  tiktok_url                 text,
  youtube_url                text,

  -- google / local
  google_rating              numeric(2,1),
  google_review_count        integer,
  google_category            text,
  google_place_id            text,

  -- registry
  company_number             text,
  incorporation_date         date,
  years_in_operation         numeric(5,1),

  -- scoring + analysis
  lead_score                 numeric(5,1),
  score_band                 text,
  website_quality_score      integer,
  landing_page_quality_score integer,
  advertising_status         text,
  opportunities              text[] not null default '{}',
  strengths                  text[] not null default '{}',
  lead_reason                text,
  recommended_service        text,

  -- full analyses, kept verbatim so the UI can grow without a migration
  website_analysis           jsonb,
  advertising_analysis       jsonb,
  score_breakdown            jsonb,
  emails                     jsonb not null default '[]'::jsonb,

  -- provenance
  sources                    text[] not null default '{}',
  search_locations           text[] not null default '{}',
  date_discovered            timestamptz,
  last_seen                  timestamptz,
  last_checked               timestamptz,

  synced_at                  timestamptz not null default now()
);

create index lead_intelligence_niche_idx      on public.lead_intelligence (niche);
create index lead_intelligence_lead_score_idx on public.lead_intelligence (lead_score desc);
create index lead_intelligence_city_idx       on public.lead_intelligence (lower(city));
create index lead_intelligence_company_idx    on public.lead_intelligence (lower(company_name));

-- ---------------------------------------------------------------------------
-- contacts
-- ---------------------------------------------------------------------------
create table public.contacts (
  id                uuid primary key default gen_random_uuid(),
  crm_lead_id       uuid not null references public.crm_leads(id) on delete cascade,
  first_name        text,
  last_name         text,
  full_name         text,
  job_title         text,
  email             text,
  phone             text,
  email_verified    boolean not null default false,
  phone_verified    boolean not null default false,
  is_primary        boolean not null default false,
  is_decision_maker boolean not null default false,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index contacts_crm_lead_id_idx on public.contacts (crm_lead_id);
create index contacts_email_idx       on public.contacts (lower(email)) where email is not null;
-- At most one primary contact per lead.
create unique index contacts_one_primary_per_lead
  on public.contacts (crm_lead_id) where is_primary;

create trigger contacts_set_updated_at
  before update on public.contacts
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- clients (declared before activities/tasks/notes which reference it)
-- ---------------------------------------------------------------------------
create table public.clients (
  id             uuid primary key default gen_random_uuid(),
  crm_lead_id    uuid references public.crm_leads(id) on delete set null,
  opportunity_id uuid,  -- FK added after opportunities exists
  company_name   text not null,
  status         crm_client_status not null default 'onboarding',
  account_owner  uuid references public.profiles(id) on delete set null,
  start_date     date,
  renewal_date   date,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index clients_crm_lead_id_idx   on public.clients (crm_lead_id);
create index clients_status_idx        on public.clients (status);
create index clients_account_owner_idx on public.clients (account_owner);
create index clients_renewal_date_idx  on public.clients (renewal_date) where renewal_date is not null;

create trigger clients_set_updated_at
  before update on public.clients
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- activities: every communication event. Deliberately event-sourced rather
-- than boolean flags (email_sent / called), so history is never lost.
-- ---------------------------------------------------------------------------
create table public.activities (
  id          uuid primary key default gen_random_uuid(),
  crm_lead_id uuid references public.crm_leads(id) on delete cascade,
  client_id   uuid references public.clients(id) on delete cascade,
  contact_id  uuid references public.contacts(id) on delete set null,
  user_id     uuid references public.profiles(id) on delete set null,
  type        crm_activity_type not null,
  direction   crm_activity_direction not null default 'outbound',
  subject     text,
  body        text,
  outcome     text,
  occurred_at timestamptz not null default now(),
  metadata    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  -- An activity must attach to something.
  constraint activities_has_subject_entity
    check (crm_lead_id is not null or client_id is not null)
);

create index activities_crm_lead_id_idx on public.activities (crm_lead_id);
create index activities_client_id_idx   on public.activities (client_id);
create index activities_contact_id_idx  on public.activities (contact_id);
create index activities_user_id_idx     on public.activities (user_id);
create index activities_occurred_at_idx on public.activities (occurred_at desc);
create index activities_type_idx        on public.activities (type);
-- The lead timeline query: newest first for one lead.
create index activities_lead_timeline_idx
  on public.activities (crm_lead_id, occurred_at desc);

-- ---------------------------------------------------------------------------
-- outreach sequences (configurable; no cadence is hard-coded)
-- ---------------------------------------------------------------------------
create table public.outreach_sequences (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  description text,
  active      boolean not null default true,
  created_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index outreach_sequences_active_idx on public.outreach_sequences (active);
create index outreach_sequences_created_by_idx on public.outreach_sequences (created_by);

create trigger outreach_sequences_set_updated_at
  before update on public.outreach_sequences
  for each row execute function public.set_updated_at();

create table public.outreach_steps (
  id               uuid primary key default gen_random_uuid(),
  sequence_id      uuid not null references public.outreach_sequences(id) on delete cascade,
  step_number      integer not null check (step_number > 0),
  channel          crm_outreach_channel not null,
  delay_minutes    integer not null default 0 check (delay_minutes >= 0),
  subject_template text,
  body_template    text,
  active           boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (sequence_id, step_number)
);

create index outreach_steps_sequence_id_idx on public.outreach_steps (sequence_id, step_number);

create trigger outreach_steps_set_updated_at
  before update on public.outreach_steps
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- lead_outreach: enrolment of a lead in a sequence
-- ---------------------------------------------------------------------------
create table public.lead_outreach (
  id           uuid primary key default gen_random_uuid(),
  crm_lead_id  uuid not null references public.crm_leads(id) on delete cascade,
  sequence_id  uuid not null references public.outreach_sequences(id) on delete restrict,
  status       crm_outreach_status not null default 'not_started',
  current_step integer not null default 0 check (current_step >= 0),
  started_at   timestamptz,
  next_step_at timestamptz,
  stopped_at   timestamptz,
  stop_reason  text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index lead_outreach_crm_lead_id_idx on public.lead_outreach (crm_lead_id);
create index lead_outreach_sequence_id_idx on public.lead_outreach (sequence_id);
create index lead_outreach_status_idx      on public.lead_outreach (status);
-- The scheduler's query: what is due next among live enrolments.
create index lead_outreach_due_idx on public.lead_outreach (next_step_at)
  where status = 'active';
-- A lead is enrolled in a given sequence once.
create unique index lead_outreach_one_per_sequence
  on public.lead_outreach (crm_lead_id, sequence_id);

create trigger lead_outreach_set_updated_at
  before update on public.lead_outreach
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- tasks
-- ---------------------------------------------------------------------------
create table public.tasks (
  id           uuid primary key default gen_random_uuid(),
  crm_lead_id  uuid references public.crm_leads(id) on delete cascade,
  client_id    uuid references public.clients(id) on delete cascade,
  assigned_to  uuid references public.profiles(id) on delete set null,
  title        text not null,
  description  text,
  status       crm_task_status not null default 'pending',
  priority     crm_task_priority not null default 'normal',
  due_at       timestamptz,
  completed_at timestamptz,
  created_by   uuid references public.profiles(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index tasks_crm_lead_id_idx on public.tasks (crm_lead_id);
create index tasks_client_id_idx   on public.tasks (client_id);
create index tasks_assigned_to_idx on public.tasks (assigned_to);
create index tasks_due_at_idx      on public.tasks (due_at);
create index tasks_status_idx      on public.tasks (status);
create index tasks_created_by_idx  on public.tasks (created_by);
-- "Today's tasks" for one user.
create index tasks_open_by_assignee_idx on public.tasks (assigned_to, due_at)
  where status in ('pending', 'in_progress');

create trigger tasks_set_updated_at
  before update on public.tasks
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- appointments (schema shaped for a later Google Calendar / Meet integration)
-- ---------------------------------------------------------------------------
create table public.appointments (
  id                uuid primary key default gen_random_uuid(),
  crm_lead_id       uuid references public.crm_leads(id) on delete cascade,
  contact_id        uuid references public.contacts(id) on delete set null,
  created_by        uuid references public.profiles(id) on delete set null,
  title             text not null,
  starts_at         timestamptz not null,
  ends_at           timestamptz,
  timezone          text not null default 'Europe/London',
  status            crm_appointment_status not null default 'scheduled',
  calendar_provider text,
  external_event_id text,
  google_meet_url   text,
  meeting_notes     text,
  outcome           text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint appointments_ends_after_starts
    check (ends_at is null or ends_at >= starts_at)
);

create index appointments_crm_lead_id_idx on public.appointments (crm_lead_id);
create index appointments_contact_id_idx  on public.appointments (contact_id);
create index appointments_starts_at_idx   on public.appointments (starts_at);
create index appointments_status_idx      on public.appointments (status);
create index appointments_created_by_idx  on public.appointments (created_by);
-- One CRM row per external calendar event, so a sync cannot duplicate.
create unique index appointments_external_event_idx
  on public.appointments (calendar_provider, external_event_id)
  where external_event_id is not null;

create trigger appointments_set_updated_at
  before update on public.appointments
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- opportunities
-- ---------------------------------------------------------------------------
create table public.opportunities (
  id                  uuid primary key default gen_random_uuid(),
  crm_lead_id         uuid not null references public.crm_leads(id) on delete cascade,
  contact_id          uuid references public.contacts(id) on delete set null,
  name                text not null,
  stage               crm_opportunity_stage not null default 'discovery',
  service_name        text,
  setup_fee           numeric(12,2),
  monthly_value       numeric(12,2),
  one_time_value      numeric(12,2),
  contract_months     integer check (contract_months is null or contract_months > 0),
  probability         smallint check (probability is null or probability between 0 and 100),
  expected_close_date date,
  pain_points         text,
  desired_outcome     text,
  budget              text,
  objections          text,
  next_action         text,
  next_action_at      timestamptz,
  owner_id            uuid references public.profiles(id) on delete set null,
  won_at              timestamptz,
  lost_at             timestamptz,
  loss_reason         text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index opportunities_crm_lead_id_idx    on public.opportunities (crm_lead_id);
create index opportunities_contact_id_idx     on public.opportunities (contact_id);
create index opportunities_stage_idx          on public.opportunities (stage);
create index opportunities_owner_id_idx       on public.opportunities (owner_id);
create index opportunities_expected_close_idx on public.opportunities (expected_close_date)
  where stage not in ('won', 'lost');

create trigger opportunities_set_updated_at
  before update on public.opportunities
  for each row execute function public.set_updated_at();

-- clients.opportunity_id FK, now that opportunities exists
-- DEFERRABLE because deleting a lead fires two referential actions against the
-- same client row (crm_lead_id -> null, opportunity_id -> null via the cascaded
-- opportunity delete). Checked immediately, the row UPDATE re-validates this FK
-- while it still points at the already-deleted opportunity and the delete fails.
alter table public.clients
  add constraint clients_opportunity_id_fkey
  foreign key (opportunity_id) references public.opportunities(id) on delete set null
  deferrable initially deferred;

create index clients_opportunity_id_idx on public.clients (opportunity_id);

-- ---------------------------------------------------------------------------
-- proposals
-- ---------------------------------------------------------------------------
create table public.proposals (
  id             uuid primary key default gen_random_uuid(),
  opportunity_id uuid not null references public.opportunities(id) on delete cascade,
  version        integer not null default 1 check (version > 0),
  status         crm_proposal_status not null default 'draft',
  title          text,
  total_value    numeric(12,2),
  setup_fee      numeric(12,2),
  monthly_value  numeric(12,2),
  valid_until    date,
  document_url   text,
  sent_at        timestamptz,
  viewed_at      timestamptz,
  accepted_at    timestamptz,
  created_by     uuid references public.profiles(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (opportunity_id, version)
);

create index proposals_opportunity_id_idx on public.proposals (opportunity_id);
create index proposals_status_idx         on public.proposals (status);
create index proposals_created_by_idx     on public.proposals (created_by);

create trigger proposals_set_updated_at
  before update on public.proposals
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- contracts
-- ---------------------------------------------------------------------------
create table public.contracts (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null references public.clients(id) on delete cascade,
  status        crm_contract_status not null default 'draft',
  start_date    date,
  end_date      date,
  monthly_value numeric(12,2),
  setup_fee     numeric(12,2),
  document_url  text,
  signed_at     timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint contracts_end_after_start
    check (end_date is null or start_date is null or end_date >= start_date)
);

create index contracts_client_id_idx on public.contracts (client_id);
create index contracts_status_idx    on public.contracts (status);

create trigger contracts_set_updated_at
  before update on public.contracts
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- payments
--
-- Stripe is the eventual source of truth: status transitions arrive by
-- webhook -> Next.js server -> service role. No user-facing UPDATE policy is
-- granted on this table, so a browser session cannot mark a payment paid.
-- ---------------------------------------------------------------------------
create table public.payments (
  id                       uuid primary key default gen_random_uuid(),
  client_id                uuid references public.clients(id) on delete cascade,
  opportunity_id           uuid references public.opportunities(id) on delete set null,
  stripe_customer_id       text,
  stripe_invoice_id        text,
  stripe_payment_intent_id text,
  stripe_subscription_id   text,
  amount                   numeric(12,2) not null,
  currency                 text not null default 'GBP',
  status                   crm_payment_status not null default 'pending',
  due_at                   timestamptz,
  paid_at                  timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

create index payments_client_id_idx      on public.payments (client_id);
create index payments_opportunity_id_idx on public.payments (opportunity_id);
create index payments_status_idx         on public.payments (status);
create index payments_due_at_idx         on public.payments (due_at);
-- Stripe object ids are unique when present: webhook replays must not duplicate.
create unique index payments_stripe_invoice_idx on public.payments (stripe_invoice_id)
  where stripe_invoice_id is not null;
create unique index payments_stripe_intent_idx  on public.payments (stripe_payment_intent_id)
  where stripe_payment_intent_id is not null;

create trigger payments_set_updated_at
  before update on public.payments
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- notes (JSONB content, ready for a rich-text editor)
-- ---------------------------------------------------------------------------
create table public.notes (
  id             uuid primary key default gen_random_uuid(),
  crm_lead_id    uuid references public.crm_leads(id) on delete cascade,
  client_id      uuid references public.clients(id) on delete cascade,
  appointment_id uuid references public.appointments(id) on delete cascade,
  author_id      uuid references public.profiles(id) on delete set null,
  title          text,
  content        jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint notes_has_subject_entity
    check (crm_lead_id is not null or client_id is not null or appointment_id is not null)
);

create index notes_crm_lead_id_idx    on public.notes (crm_lead_id);
create index notes_client_id_idx      on public.notes (client_id);
create index notes_appointment_id_idx on public.notes (appointment_id);
create index notes_author_id_idx      on public.notes (author_id);

create trigger notes_set_updated_at
  before update on public.notes
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- documents (Supabase Storage paths)
-- ---------------------------------------------------------------------------
create table public.documents (
  id           uuid primary key default gen_random_uuid(),
  crm_lead_id  uuid references public.crm_leads(id) on delete cascade,
  client_id    uuid references public.clients(id) on delete cascade,
  uploaded_by  uuid references public.profiles(id) on delete set null,
  name         text not null,
  storage_path text not null,
  mime_type    text,
  file_size    bigint check (file_size is null or file_size >= 0),
  created_at   timestamptz not null default now(),
  constraint documents_has_subject_entity
    check (crm_lead_id is not null or client_id is not null)
);

create index documents_crm_lead_id_idx on public.documents (crm_lead_id);
create index documents_client_id_idx   on public.documents (client_id);
create index documents_uploaded_by_idx on public.documents (uploaded_by);

-- ---------------------------------------------------------------------------
-- pipeline_stage_history + automatic transition capture
-- ---------------------------------------------------------------------------
create table public.pipeline_stage_history (
  id          uuid primary key default gen_random_uuid(),
  crm_lead_id uuid not null references public.crm_leads(id) on delete cascade,
  from_stage  crm_pipeline_stage,
  to_stage    crm_pipeline_stage not null,
  changed_by  uuid references public.profiles(id) on delete set null,
  reason      text,
  created_at  timestamptz not null default now()
);

create index pipeline_stage_history_crm_lead_id_idx
  on public.pipeline_stage_history (crm_lead_id, created_at desc);
create index pipeline_stage_history_to_stage_idx
  on public.pipeline_stage_history (to_stage, created_at desc);
-- FK to profiles: keeps deleting a user from seq-scanning the audit trail.
create index pipeline_stage_history_changed_by_idx
  on public.pipeline_stage_history (changed_by);

-- Recorded by trigger, not by the application: a transition written directly
-- in SQL or from a background job still lands in the history. This is what
-- makes funnel analytics (lead->contact, reply rate, close rate, cycle time)
-- trustworthy later.
create or replace function public.record_pipeline_stage_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.pipeline_stage_history (crm_lead_id, from_stage, to_stage, changed_by)
    values (new.id, null, new.pipeline_stage, auth.uid());
  elsif new.pipeline_stage is distinct from old.pipeline_stage then
    insert into public.pipeline_stage_history (crm_lead_id, from_stage, to_stage, changed_by)
    values (new.id, old.pipeline_stage, new.pipeline_stage, auth.uid());

    -- Keep the funnel timestamps honest without asking callers to remember.
    if new.pipeline_stage = 'contacted' and new.first_contacted_at is null then
      new.first_contacted_at = now();
    end if;
    if new.pipeline_stage = 'replied' and new.first_replied_at is null then
      new.first_replied_at = now();
    end if;
    if new.pipeline_stage = 'won' and new.converted_at is null then
      new.converted_at = now();
    end if;
  end if;
  return new;
end;
$$;

create trigger crm_leads_record_stage_insert
  after insert on public.crm_leads
  for each row execute function public.record_pipeline_stage_change();

create trigger crm_leads_record_stage_update
  before update of pipeline_stage on public.crm_leads
  for each row execute function public.record_pipeline_stage_change();

-- ---------------------------------------------------------------------------
-- Inbound reply halts automated outreach.
--
-- Business rule from the spec, enforced in the database so it holds no matter
-- which code path records the reply: an inbound activity stops every live
-- sequence for that lead and moves the lead to `replied`.
-- ---------------------------------------------------------------------------
create or replace function public.halt_outreach_on_inbound_reply()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.direction <> 'inbound'
     or new.crm_lead_id is null
     or new.type not in ('email', 'call', 'sms', 'voicemail', 'meeting') then
    return new;
  end if;

  update public.lead_outreach
     set status      = 'replied',
         stopped_at  = now(),
         stop_reason = 'Inbound reply received',
         next_step_at = null
   where crm_lead_id = new.crm_lead_id
     and status in ('not_started', 'active', 'paused');

  -- Only advance stages that precede a reply; never regress a lead that has
  -- already progressed to an appointment, opportunity or win.
  update public.crm_leads
     set pipeline_stage    = 'replied',
         first_replied_at  = coalesce(first_replied_at, new.occurred_at)
   where id = new.crm_lead_id
     and pipeline_stage in ('qualified', 'ready_for_outreach', 'contacted');

  return new;
end;
$$;

create trigger activities_halt_outreach_on_reply
  after insert on public.activities
  for each row execute function public.halt_outreach_on_inbound_reply();

-- ============================================================================
-- Row Level Security
--
-- Model:
--   * every CRM table has RLS enabled;
--   * reads are open to any active profile (a small agency shares its pipeline);
--   * writes require a non-viewer role;
--   * destructive deletes are admin-only;
--   * lead_intelligence and payments have NO user write policies at all, so
--     only the service role can change scraped data or payment status.
--
-- The service role bypasses RLS entirely and is used server-side only.
-- ============================================================================
alter table public.profiles               enable row level security;
alter table public.crm_leads              enable row level security;
alter table public.lead_intelligence      enable row level security;
alter table public.contacts               enable row level security;
alter table public.activities             enable row level security;
alter table public.outreach_sequences     enable row level security;
alter table public.outreach_steps         enable row level security;
alter table public.lead_outreach          enable row level security;
alter table public.tasks                  enable row level security;
alter table public.appointments           enable row level security;
alter table public.opportunities          enable row level security;
alter table public.proposals              enable row level security;
alter table public.clients                enable row level security;
alter table public.contracts              enable row level security;
alter table public.payments               enable row level security;
alter table public.notes                  enable row level security;
alter table public.documents              enable row level security;
alter table public.pipeline_stage_history enable row level security;

-- profiles ------------------------------------------------------------------
create policy profiles_select_self_or_member on public.profiles
  for select to authenticated
  using (id = auth.uid() or public.crm_is_member());

create policy profiles_update_self on public.profiles
  for update to authenticated
  using (id = auth.uid())
  -- A user may edit their own profile but not promote themselves.
  with check (id = auth.uid() and role = public.crm_role_of(auth.uid()));

create policy profiles_admin_all on public.profiles
  for all to authenticated
  using (public.crm_is_admin())
  with check (public.crm_is_admin());

-- crm_leads -----------------------------------------------------------------
create policy crm_leads_select on public.crm_leads
  for select to authenticated using (public.crm_is_member());

create policy crm_leads_insert on public.crm_leads
  for insert to authenticated with check (public.crm_can_write());

create policy crm_leads_update on public.crm_leads
  for update to authenticated
  using (public.crm_can_write()) with check (public.crm_can_write());

create policy crm_leads_delete_admin on public.crm_leads
  for delete to authenticated using (public.crm_is_admin());

-- lead_intelligence: read-only to every member; written by the sync only.
create policy lead_intelligence_select on public.lead_intelligence
  for select to authenticated using (public.crm_is_member());

-- pipeline_stage_history: append-only audit trail, never edited by hand.
create policy pipeline_stage_history_select on public.pipeline_stage_history
  for select to authenticated using (public.crm_is_member());

-- payments: readable by members; status changes come from Stripe webhooks.
create policy payments_select on public.payments
  for select to authenticated using (public.crm_is_member());

-- Standard read-for-members / write-for-staff tables.
do $$
declare
  t text;
begin
  foreach t in array array[
    'contacts', 'activities', 'outreach_sequences', 'outreach_steps',
    'lead_outreach', 'tasks', 'appointments', 'opportunities', 'proposals',
    'clients', 'contracts', 'notes', 'documents'
  ]
  loop
    execute format(
      'create policy %1$s_select on public.%1$s
         for select to authenticated using (public.crm_is_member())', t);
    execute format(
      'create policy %1$s_insert on public.%1$s
         for insert to authenticated with check (public.crm_can_write())', t);
    execute format(
      'create policy %1$s_update on public.%1$s
         for update to authenticated
         using (public.crm_can_write()) with check (public.crm_can_write())', t);
    execute format(
      'create policy %1$s_delete on public.%1$s
         for delete to authenticated using (public.crm_is_admin())', t);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- New auth users get a profile automatically, defaulting to the least
-- privileged role. An admin promotes them afterwards.
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, new.raw_user_meta_data ->> 'full_name')
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

-- ============================================================================
-- Sprint 6: the outreach engine.
--
-- Until now nothing in this CRM has ever sent a message to a lead. This
-- migration is what changes that, so it is built around the things that make
-- unattended sending safe rather than merely possible.
--
-- SENDING IS OFF UNTIL SOMEBODY TURNS IT ON. `outreach_settings.sending_enabled`
-- defaults to false. Applying this migration to a database full of scraped
-- leads must not start emailing them, and a default of true would mean exactly
-- that the moment a cron job was pointed at the run endpoint.
--
-- SUPPRESSION IS A HARD GATE. An address that unsubscribed, bounced or
-- complained is in `suppressions`, and `crm_is_suppressed()` is checked before
-- every send. Not a filter on a list somewhere — a lookup on the send path.
--
-- REPLIES STOP SEQUENCES, and the machinery for that already exists:
-- `halt_outreach_on_inbound_reply` fires on any inbound activity. The inbound
-- webhook writes one, so reply detection is the trigger written in the very
-- first migration rather than a second implementation that can disagree.
--
-- THE LEDGER IS APPEND-ONLY FROM THE UI'S POINT OF VIEW. `outreach_messages`
-- and `inbound_messages` have no write policy for any CRM role. What was sent
-- to whom is a record, not a field.
-- ============================================================================

-- For gen_random_bytes(), used to mint unsubscribe tokens. `gen_random_uuid()`
-- is core in Postgres 13+ but the byte generator is not. Supabase ships this
-- already enabled, so the guard makes it a no-op there.
create extension if not exists pgcrypto;

create type crm_message_status as enum (
  'queued', 'sent', 'delivered', 'opened', 'clicked',
  'bounced', 'complained', 'failed', 'skipped'
);

create type crm_suppression_reason as enum (
  'unsubscribed', 'bounced', 'complained', 'manual', 'invalid'
);

-- ---------------------------------------------------------------------------
-- outreach_settings: one row, and the safety catch lives on it.
--
-- A singleton rather than environment variables because these are decisions an
-- owner makes and changes — the daily cap and the sending window are operating
-- choices, not deployment configuration.
-- ---------------------------------------------------------------------------
create table public.outreach_settings (
  id                    boolean primary key default true check (id),

  -- The kill switch. Off by default; see the header.
  sending_enabled       boolean not null default false,

  -- Sender identity. Required on every marketing email in the UK: the
  -- recipient has to be able to tell who sent it and how to stop it.
  from_name             text,
  from_email            text,
  reply_to_email        text,
  sms_from_number       text,
  -- Appears in the footer of every email, with the unsubscribe link.
  postal_address        text,

  -- Volume and timing. A cold outreach run that fires two hundred emails in
  -- ten seconds is how a sending domain gets blocked.
  daily_send_limit      integer not null default 50 check (daily_send_limit >= 0),
  per_run_limit         integer not null default 25 check (per_run_limit >= 0),
  min_seconds_between_sends integer not null default 30 check (min_seconds_between_sends >= 0),

  -- Business hours, in `timezone`. Nothing goes out at 3am.
  send_window_start     smallint not null default 9  check (send_window_start between 0 and 23),
  send_window_end       smallint not null default 17 check (send_window_end between 0 and 23),
  send_on_weekends      boolean not null default false,
  timezone              text not null default 'Europe/London',

  updated_by            uuid references public.profiles(id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint outreach_settings_window_ordered
    check (send_window_end > send_window_start)
);

create index outreach_settings_updated_by_idx on public.outreach_settings (updated_by);

create trigger outreach_settings_set_updated_at
  before update on public.outreach_settings
  for each row execute function public.set_updated_at();

-- The single row. Created here so the app never has to handle its absence.
insert into public.outreach_settings (id) values (true);

-- ---------------------------------------------------------------------------
-- suppressions: addresses that must never be contacted again.
--
-- The most important table in this migration. An unsubscribe that does not
-- stick is not a bug, it is the thing regulators fine people for, so it is
-- stored independently of any lead, contact or sequence: deleting a lead must
-- not resurrect permission to email them.
-- ---------------------------------------------------------------------------
create table public.suppressions (
  id          uuid primary key default gen_random_uuid(),
  -- Lower-cased on write by the trigger below; matching is exact after that.
  email       text,
  phone       text,
  reason      crm_suppression_reason not null,
  source      text,
  notes       text,
  -- Kept for context only. The suppression survives the lead being deleted.
  crm_lead_id uuid references public.crm_leads(id) on delete set null,
  created_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),

  constraint suppressions_has_a_target check (email is not null or phone is not null)
);

create unique index suppressions_email_idx on public.suppressions (email) where email is not null;
create unique index suppressions_phone_idx on public.suppressions (phone) where phone is not null;
create index suppressions_lead_idx       on public.suppressions (crm_lead_id);
create index suppressions_created_by_idx on public.suppressions (created_by);

/**
 * Normalise before storing.
 *
 * "Owner@Practice.co.uk" and "owner@practice.co.uk" are the same inbox, and a
 * suppression that only matches one casing is a suppression that does not work.
 * Phone numbers keep only their digits and a leading +, so the same number
 * written three ways suppresses once.
 */
create or replace function public.normalise_suppression()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  new.email = nullif(lower(btrim(coalesce(new.email, ''))), '');
  new.phone = nullif(regexp_replace(coalesce(new.phone, ''), '[^0-9+]', '', 'g'), '');
  return new;
end;
$$;

create trigger suppressions_normalise
  before insert or update on public.suppressions
  for each row execute function public.normalise_suppression();

/**
 * The gate, callable from anywhere.
 *
 * SECURITY DEFINER so the send path can consult it, and so a page can grey out
 * a control, without granting anyone a readable list of everybody who ever
 * unsubscribed.
 */
create or replace function public.crm_is_suppressed(p_email text, p_phone text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.suppressions
     where (p_email is not null
            and email = nullif(lower(btrim(p_email)), ''))
        or (p_phone is not null
            and phone = nullif(regexp_replace(p_phone, '[^0-9+]', '', 'g'), ''))
  );
$$;

-- ---------------------------------------------------------------------------
-- outreach_messages: everything the engine sent, or refused to send.
--
-- Skipped sends are recorded too, with the reason. "Why did this lead never
-- get step 3" is the question this table exists to answer, and a row that only
-- appears on success cannot answer it.
-- ---------------------------------------------------------------------------
create table public.outreach_messages (
  id                uuid primary key default gen_random_uuid(),
  lead_outreach_id  uuid references public.lead_outreach(id) on delete set null,
  crm_lead_id       uuid references public.crm_leads(id) on delete cascade,
  contact_id        uuid references public.contacts(id) on delete set null,
  step_id           uuid references public.outreach_steps(id) on delete set null,
  step_number       integer,

  channel           crm_outreach_channel not null,
  status            crm_message_status not null default 'queued',

  -- Exactly what went out, kept verbatim. A template changed later must not
  -- rewrite the history of what a lead was actually sent.
  to_email          text,
  to_phone          text,
  from_email        text,
  from_phone        text,
  subject           text,
  body              text,

  provider          text,
  provider_message_id text,
  error             text,
  /** Why a send was skipped: suppressed, no address, outside window, capped. */
  skip_reason       text,

  sent_at           timestamptz,
  delivered_at      timestamptz,
  bounced_at        timestamptz,
  complained_at     timestamptz,
  opened_at         timestamptz,
  clicked_at        timestamptz,
  last_event_at     timestamptz,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index outreach_messages_lead_idx      on public.outreach_messages (crm_lead_id, created_at desc);
create index outreach_messages_enrolment_idx on public.outreach_messages (lead_outreach_id);
create index outreach_messages_status_idx    on public.outreach_messages (status);
create index outreach_messages_contact_idx   on public.outreach_messages (contact_id);
create index outreach_messages_step_idx      on public.outreach_messages (step_id);
-- The daily cap query.
create index outreach_messages_sent_at_idx   on public.outreach_messages (sent_at desc)
  where sent_at is not null;
-- Provider callbacks arrive keyed on their own id; a replay must not duplicate.
create unique index outreach_messages_provider_idx
  on public.outreach_messages (provider, provider_message_id)
  where provider_message_id is not null;
-- One send per step per enrolment, so a re-run cannot email the same person
-- the same step twice. This is the backstop behind the engine's own checks.
create unique index outreach_messages_one_per_step
  on public.outreach_messages (lead_outreach_id, step_id)
  where lead_outreach_id is not null and step_id is not null;

create trigger outreach_messages_set_updated_at
  before update on public.outreach_messages
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- inbound_messages: what came back.
--
-- Stored in its own table rather than only as an activity, because a reply has
-- provider detail (message id, in-reply-to, raw sender) that the timeline does
-- not want but a bug report does.
-- ---------------------------------------------------------------------------
create table public.inbound_messages (
  id                  uuid primary key default gen_random_uuid(),
  crm_lead_id         uuid references public.crm_leads(id) on delete cascade,
  contact_id          uuid references public.contacts(id) on delete set null,
  outreach_message_id uuid references public.outreach_messages(id) on delete set null,

  channel             crm_outreach_channel not null,
  from_email          text,
  from_phone          text,
  to_email            text,
  to_phone            text,
  subject             text,
  body                text,

  provider            text,
  provider_message_id text,
  in_reply_to         text,
  /** True when the body read as a request to stop. See detectOptOut(). */
  is_opt_out          boolean not null default false,
  /** Set once the reply has been turned into an activity. */
  processed_at        timestamptz,

  received_at         timestamptz not null default now(),
  created_at          timestamptz not null default now()
);

create index inbound_messages_lead_idx     on public.inbound_messages (crm_lead_id, received_at desc);
create index inbound_messages_contact_idx  on public.inbound_messages (contact_id);
create index inbound_messages_outbound_idx on public.inbound_messages (outreach_message_id);
create index inbound_messages_channel_idx  on public.inbound_messages (channel);
create index inbound_messages_unmatched_idx on public.inbound_messages (received_at desc)
  where crm_lead_id is null;
create unique index inbound_messages_provider_idx
  on public.inbound_messages (provider, provider_message_id)
  where provider_message_id is not null;

-- ---------------------------------------------------------------------------
-- provider_events: webhook idempotency, same pattern as stripe_events.
-- ---------------------------------------------------------------------------
create table public.provider_events (
  id           text primary key,          -- provider:event_id
  provider     text not null,
  type         text not null,
  received_at  timestamptz not null default now(),
  processed_at timestamptz,
  status       text not null default 'received',
  error        text
);

create index provider_events_received_idx on public.provider_events (received_at desc);

-- ---------------------------------------------------------------------------
-- Enrolments and steps gain what the engine needs.
-- ---------------------------------------------------------------------------
alter table public.lead_outreach
  -- Who is being written to. Without this the engine would have to re-guess
  -- the recipient on every step and could switch person mid-sequence.
  add column contact_id       uuid references public.contacts(id) on delete set null,
  add column enrolled_by      uuid references public.profiles(id) on delete set null,
  -- Opaque, per-enrolment, and the only thing in an unsubscribe link. A URL
  -- carrying a lead id would let anyone unsubscribe anyone by counting.
  add column unsubscribe_token text not null default encode(gen_random_bytes(24), 'hex'),
  add column last_error       text,
  add column last_sent_at     timestamptz;

create unique index lead_outreach_unsubscribe_token_idx
  on public.lead_outreach (unsubscribe_token);
create index lead_outreach_contact_idx on public.lead_outreach (contact_id);
create index lead_outreach_enrolled_by_idx on public.lead_outreach (enrolled_by);

alter table public.outreach_steps
  -- A `call` step is work for a person, not something the engine sends. It
  -- creates a task and waits for the call to be logged.
  add column task_title       text,
  -- Skip the business-hours check for this step. Rare, and explicit.
  add column ignore_send_window boolean not null default false;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
alter table public.outreach_settings   enable row level security;
alter table public.suppressions        enable row level security;
alter table public.outreach_messages   enable row level security;
alter table public.inbound_messages    enable row level security;
alter table public.provider_events     enable row level security;

-- Settings: everyone sees the configuration, only an admin changes it. Turning
-- sending on is not a decision for whoever happens to be logged in.
create policy outreach_settings_select on public.outreach_settings
  for select to authenticated using (public.crm_is_member());
create policy outreach_settings_update on public.outreach_settings
  for update to authenticated
  using (public.crm_is_admin()) with check (public.crm_is_admin());

-- Suppressions: any writer may add one — "never contact this address again" is
-- a request anyone should be able to honour immediately. Removal is admin-only,
-- because taking someone off the list is what puts them back in the send path.
create policy suppressions_select on public.suppressions
  for select to authenticated using (public.crm_is_member());
create policy suppressions_insert on public.suppressions
  for insert to authenticated with check (public.crm_can_write());
create policy suppressions_delete on public.suppressions
  for delete to authenticated using (public.crm_is_admin());

-- The ledgers are readable and nothing more. What was sent is a record.
create policy outreach_messages_select on public.outreach_messages
  for select to authenticated using (public.crm_is_member());
create policy inbound_messages_select on public.inbound_messages
  for select to authenticated using (public.crm_is_member());

-- provider_events gets no policy at all.

comment on table public.outreach_settings is
  'Singleton. sending_enabled defaults to false so applying this migration never starts sending.';
comment on table public.suppressions is
  'Do-not-contact list. Survives lead deletion; checked on the send path by crm_is_suppressed().';
comment on table public.outreach_messages is
  'Send ledger, including refusals with a skip_reason. Read-only to every CRM role.';
comment on column public.lead_outreach.unsubscribe_token is
  'Opaque per-enrolment token. The only identifier in an unsubscribe URL.';

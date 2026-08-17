-- ============================================================================
-- Sprint 4: Google Calendar.
--
-- Three things the schema has to get right before any code is written.
--
-- 1. OAUTH TOKENS ARE NOT CRM DATA.
--    A Google refresh token is a long-lived credential to somebody's entire
--    calendar. It lives in its own table with RLS enabled and NO POLICIES AT
--    ALL, so no signed-in user can read it through PostgREST no matter what
--    their role is - only the service role, server-side, can. The application
--    additionally encrypts the values before they are stored, so a database
--    dump on its own is not a set of live Google credentials.
--
-- 2. THE UI CANNOT FAKE A CONNECTION.
--    `calendar_accounts` has SELECT and DELETE policies (see your own
--    connection, disconnect it) but no INSERT or UPDATE policy. A connection
--    can only be created by the OAuth callback running as the service role
--    after Google has actually authenticated the user.
--
-- 3. DELETES HAVE TO OUTLIVE THE ROW.
--    Removing an appointment in the CRM should remove the event from Google,
--    but by the time the sync runs the row - and its external_event_id - is
--    gone. A trigger writes the id to an outbox first.
-- ============================================================================

create type crm_calendar_provider as enum ('google');

-- pending: changed here, not yet pushed. synced: agrees with the remote copy.
-- failed: the last push was rejected; sync_error says why.
create type crm_calendar_sync_state as enum ('local', 'pending', 'synced', 'failed');

-- ---------------------------------------------------------------------------
-- calendar_accounts: one connected Google account per person.
--
-- Per person, not per agency: the appointments belong to whoever is running
-- the call, and a shared account would put every rep's day in one calendar.
-- ---------------------------------------------------------------------------
create table public.calendar_accounts (
  id                    uuid primary key default gen_random_uuid(),
  profile_id            uuid not null unique references public.profiles(id) on delete cascade,
  provider              crm_calendar_provider not null default 'google',

  -- Which Google account, and which of its calendars. Shown in the UI so it is
  -- obvious whose diary the CRM is writing to.
  google_email          text not null,
  calendar_id           text not null default 'primary',
  scope                 text,

  -- Google's incremental sync cursor. Null forces a full resync, which is also
  -- what a 410 GONE response resets it to.
  sync_token            text,

  -- Push notification channel, when one has been opened.
  channel_id            text,
  channel_resource_id   text,
  channel_expires_at    timestamptz,

  last_synced_at        timestamptz,
  last_sync_summary     jsonb,
  last_error            text,
  is_active             boolean not null default true,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index calendar_accounts_profile_id_idx on public.calendar_accounts (profile_id);
create unique index calendar_accounts_channel_id_idx
  on public.calendar_accounts (channel_id) where channel_id is not null;

create trigger calendar_accounts_set_updated_at
  before update on public.calendar_accounts
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- calendar_credentials: the tokens themselves.
--
-- Separate table rather than columns on calendar_accounts, because RLS is
-- row-level: there is no way to let someone read their own connection's email
-- address while hiding its refresh token if the two live in the same row.
--
-- RLS is enabled and deliberately no policy is ever created. That is the whole
-- security model for this table - PostgREST returns nothing to anon,
-- authenticated, or any CRM role, and only the service-role client can reach
-- it.
-- ---------------------------------------------------------------------------
create table public.calendar_credentials (
  calendar_account_id uuid primary key
    references public.calendar_accounts(id) on delete cascade,

  -- Ciphertext, not tokens. Sealed by the application with AES-256-GCM before
  -- it ever reaches Postgres; see src/lib/calendar/crypto.ts.
  access_token_enc    text not null,
  refresh_token_enc   text,
  token_expires_at    timestamptz,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create trigger calendar_credentials_set_updated_at
  before update on public.calendar_credentials
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Appointments gain the sync columns.
--
-- `calendar_provider`, `external_event_id` and `google_meet_url` were cut in
-- the original migration for exactly this, and the unique index on
-- (calendar_provider, external_event_id) already stops a repeated pull from
-- duplicating an event.
-- ---------------------------------------------------------------------------
alter table public.appointments
  add column calendar_account_id  uuid references public.calendar_accounts(id) on delete set null,
  add column sync_state           crm_calendar_sync_state not null default 'local',
  add column sync_error           text,
  add column synced_at            timestamptz,
  -- Google's own last-modified stamp, so a two-way sync can tell which side
  -- moved most recently instead of guessing.
  add column external_updated_at  timestamptz,
  add column external_html_link   text,
  -- The user asked for a Meet link; google_meet_url is what came back.
  add column conference_requested boolean not null default false,
  add column attendee_emails      text[] not null default '{}'::text[],
  -- Opt-in, and off by default. Adding an attendee to a Google event makes
  -- Google email them, and this CRM does not contact leads on its own - so the
  -- API is called with sendUpdates=none unless somebody explicitly ticks this.
  add column notify_attendees     boolean not null default false;

create index appointments_calendar_account_idx
  on public.appointments (calendar_account_id) where calendar_account_id is not null;
-- The push queue: everything waiting to go to Google.
create index appointments_sync_state_idx
  on public.appointments (sync_state) where sync_state in ('pending', 'failed');

-- ---------------------------------------------------------------------------
-- calendar_deletions: the outbox.
--
-- An appointment deleted in the CRM has to be deleted in Google, but the row
-- carrying external_event_id is gone by the time the sync next runs. The
-- trigger copies what the delete needs before it disappears.
--
-- Service-role only, same as the credentials: nothing in the UI reads or
-- writes this.
-- ---------------------------------------------------------------------------
create table public.calendar_deletions (
  id                  uuid primary key default gen_random_uuid(),
  calendar_account_id uuid not null references public.calendar_accounts(id) on delete cascade,
  calendar_id         text not null,
  external_event_id   text not null,
  attempts            integer not null default 0,
  last_error          text,
  created_at          timestamptz not null default now()
);

create index calendar_deletions_account_idx on public.calendar_deletions (calendar_account_id);

create or replace function public.queue_calendar_deletion()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_calendar_id text;
begin
  if old.external_event_id is null or old.calendar_account_id is null then
    return old;
  end if;

  -- The account may be going away in the same statement (profile deleted), in
  -- which case there is nothing left to delete against.
  select calendar_id into v_calendar_id
    from public.calendar_accounts where id = old.calendar_account_id;
  if not found then
    return old;
  end if;

  insert into public.calendar_deletions
    (calendar_account_id, calendar_id, external_event_id)
  values
    (old.calendar_account_id, v_calendar_id, old.external_event_id);

  return old;
end;
$$;

create trigger appointments_queue_calendar_deletion
  after delete on public.appointments
  for each row execute function public.queue_calendar_deletion();

-- ---------------------------------------------------------------------------
-- An edit here is an edit that has to reach Google.
--
-- In application code this would be one forgotten call away from a calendar
-- that quietly stops matching the CRM, so the flag is set by the database on
-- any change to a field the remote event actually carries. Changing only
-- `meeting_notes` or `outcome` does not dirty the event, because Google never
-- saw those.
-- ---------------------------------------------------------------------------
create or replace function public.mark_appointment_dirty()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  -- Not linked to a calendar: nothing to push.
  if new.calendar_account_id is null then
    return new;
  end if;

  -- The sync itself writes sync_state; leave its own updates alone.
  if new.sync_state is distinct from old.sync_state then
    return new;
  end if;

  if new.title                is distinct from old.title
     or new.starts_at         is distinct from old.starts_at
     or new.ends_at           is distinct from old.ends_at
     or new.timezone          is distinct from old.timezone
     or new.status            is distinct from old.status
     or new.attendee_emails   is distinct from old.attendee_emails
     or new.conference_requested is distinct from old.conference_requested then
    new.sync_state = 'pending';
  end if;

  return new;
end;
$$;

create trigger appointments_mark_dirty
  before update on public.appointments
  for each row execute function public.mark_appointment_dirty();

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
alter table public.calendar_accounts    enable row level security;
alter table public.calendar_credentials enable row level security;
alter table public.calendar_deletions   enable row level security;

-- Your own connection, or any of them if you are an admin. Nobody else's:
-- which calendar a colleague connected is their business, and the row carries
-- their personal Google address.
create policy calendar_accounts_select on public.calendar_accounts
  for select to authenticated
  using (profile_id = auth.uid() or public.crm_is_admin());

-- Disconnecting is yours to do. No INSERT or UPDATE policy exists: a
-- connection can only be created by the OAuth callback as the service role,
-- after Google has authenticated the user, so the UI cannot assert a
-- connection that does not exist.
create policy calendar_accounts_delete on public.calendar_accounts
  for delete to authenticated
  using (profile_id = auth.uid() or public.crm_is_admin());

-- calendar_credentials and calendar_deletions get NO policies. That is the
-- point of them. RLS is on, the policy list is empty, so every request that is
-- not the service role reads and writes nothing.

comment on table public.calendar_credentials is
  'OAuth tokens. RLS enabled with no policies on purpose: service role only. Values are application-encrypted.';
comment on table public.calendar_deletions is
  'Outbox of events to delete from Google after the appointment row is gone. Service role only.';
comment on column public.appointments.notify_attendees is
  'Off by default. Google emails attendees on write unless sendUpdates=none, and this CRM does not contact people on its own.';

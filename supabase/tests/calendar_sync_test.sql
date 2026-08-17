-- ============================================================================
-- Behavioural tests for the calendar schema (20260819_calendar_sync).
--
-- The important ones are the RLS assertions. `calendar_credentials` holds live
-- Google refresh tokens and its entire security model is "RLS is on and there
-- are no policies" - which is invisible in the migration unless you notice
-- what is absent. A policy added later by accident would open it silently, so
-- the absence is asserted rather than assumed.
-- ============================================================================
\set ON_ERROR_STOP on

create or replace function pg_temp.assert(condition boolean, message text)
returns void language plpgsql as $$
begin
  if condition is not true then
    raise exception 'ASSERTION FAILED: %', message;
  end if;
  raise notice '  ok  %', message;
end;
$$;

-- Fixtures, as superuser.
do $$
declare
  rep_id uuid;
  other_id uuid;
begin
  insert into auth.users (email) values ('cal-rep@agency.test') returning id into rep_id;
  update public.profiles set role = 'sales' where id = rep_id;

  insert into auth.users (email) values ('cal-other@agency.test') returning id into other_id;
  update public.profiles set role = 'sales' where id = other_id;

  insert into auth.users (email) values ('cal-admin@agency.test');
  update public.profiles set role = 'admin' where email = 'cal-admin@agency.test';

  insert into public.calendar_accounts (profile_id, google_email, calendar_id)
  values (rep_id, 'rep@gmail.test', 'primary');
  insert into public.calendar_accounts (profile_id, google_email, calendar_id)
  values (other_id, 'other@gmail.test', 'primary');

  insert into public.calendar_credentials (calendar_account_id, access_token_enc, refresh_token_enc)
  select id, 'v1.sealed.access', 'v1.sealed.refresh'
    from public.calendar_accounts where google_email = 'rep@gmail.test';
end;
$$;

create or replace function pg_temp.profile_id(addr text) returns uuid
language sql stable security definer as $$
  select id from public.profiles where email = addr;
$$;

create or replace function pg_temp.account_id(addr text) returns uuid
language sql stable security definer as $$
  select id from public.calendar_accounts where google_email = addr;
$$;

-- ---------------------------------------------------------------------------
\echo '== structure =='
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['calendar_accounts', 'calendar_credentials', 'calendar_deletions'] loop
    perform pg_temp.assert(to_regclass('public.' || t) is not null, format('table %s exists', t));
    perform pg_temp.assert(
      (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass),
      format('RLS enabled on %s', t));
  end loop;

  perform pg_temp.assert(
    exists (select 1 from information_schema.columns
             where table_name = 'appointments' and column_name = 'sync_state'),
    'appointments carries a sync state');
  perform pg_temp.assert(
    exists (select 1 from information_schema.columns
             where table_name = 'appointments' and column_name = 'notify_attendees'),
    'appointments carries the notify opt-in');
  perform pg_temp.assert(
    (select column_default from information_schema.columns
      where table_name = 'appointments' and column_name = 'notify_attendees') = 'false',
    'attendee notification is off by default, in the database as well as the form');

  perform pg_temp.assert(
    exists (select 1 from pg_indexes
             where indexname = 'appointments_external_event_idx'),
    'one CRM row per external event, so a repeated pull cannot duplicate');
end;
$$;

-- ---------------------------------------------------------------------------
\echo '== credentials are service-role only =='
-- ---------------------------------------------------------------------------
do $$
begin
  -- The whole security model, asserted rather than assumed.
  perform pg_temp.assert(
    not exists (select 1 from pg_policies
                 where schemaname = 'public' and tablename = 'calendar_credentials'),
    'calendar_credentials has NO policies at all');
  perform pg_temp.assert(
    not exists (select 1 from pg_policies
                 where schemaname = 'public' and tablename = 'calendar_deletions'),
    'calendar_deletions has NO policies at all');
end;
$$;

do $$
declare
  visible int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', pg_temp.profile_id('cal-rep@agency.test')::text, true);

  -- The owner of the tokens cannot read them either. There is no CRM role that
  -- can; only the service-role client, server-side.
  select count(*) into visible from public.calendar_credentials;
  perform pg_temp.assert(visible = 0, 'even the account owner cannot read their own tokens');

  perform set_config('request.jwt.claim.sub', pg_temp.profile_id('cal-admin@agency.test')::text, true);
  select count(*) into visible from public.calendar_credentials;
  perform pg_temp.assert(visible = 0, 'an admin cannot read tokens either');

  select count(*) into visible from public.calendar_deletions;
  perform pg_temp.assert(visible = 0, 'the deletion outbox is invisible to the UI');

  reset role;
end;
$$;

do $$
declare refused boolean := false;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', pg_temp.profile_id('cal-rep@agency.test')::text, true);

  begin
    insert into public.calendar_credentials (calendar_account_id, access_token_enc)
    values (pg_temp.account_id('rep@gmail.test'), 'v1.forged');
  exception when insufficient_privilege then refused := true;
  end;
  perform pg_temp.assert(refused, 'nobody can write a token through PostgREST');

  reset role;
end;
$$;

-- ---------------------------------------------------------------------------
\echo '== connections are personal =='
-- ---------------------------------------------------------------------------
do $$
declare
  visible int;
  refused boolean;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', pg_temp.profile_id('cal-rep@agency.test')::text, true);

  select count(*) into visible from public.calendar_accounts;
  perform pg_temp.assert(visible = 1, 'a rep sees their own connection and no one else''s');
  perform pg_temp.assert(
    (select google_email from public.calendar_accounts) = 'rep@gmail.test',
    'and it is theirs');

  -- No INSERT policy: a connection can only come from the OAuth callback
  -- running as the service role, after Google authenticated the user.
  refused := false;
  begin
    insert into public.calendar_accounts (profile_id, google_email)
    values (pg_temp.profile_id('cal-rep@agency.test'), 'faked@gmail.test');
  exception when others then refused := true;
  end;
  perform pg_temp.assert(refused, 'the UI cannot assert a calendar connection that does not exist');

  -- No UPDATE policy either, so a sync cursor cannot be rewritten from a form.
  update public.calendar_accounts set sync_token = 'tampered';
  perform pg_temp.assert(
    (select sync_token from public.calendar_accounts
      where google_email = 'rep@gmail.test') is null,
    'and cannot edit one');

  reset role;
end;
$$;

do $$
declare visible int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', pg_temp.profile_id('cal-admin@agency.test')::text, true);
  select count(*) into visible from public.calendar_accounts;
  perform pg_temp.assert(visible = 2, 'an admin sees every connection');
  reset role;
end;
$$;

do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', pg_temp.profile_id('cal-other@agency.test')::text, true);

  -- Disconnecting is the one write a person may do, and only to their own.
  delete from public.calendar_accounts;
  reset role;

  perform pg_temp.assert(
    not exists (select 1 from public.calendar_accounts where google_email = 'other@gmail.test'),
    'a rep can disconnect their own calendar');
  perform pg_temp.assert(
    exists (select 1 from public.calendar_accounts where google_email = 'rep@gmail.test'),
    'and cannot disconnect anybody else''s');
end;
$$;

-- Real Supabase grants `anon` SELECT on public tables and relies on RLS to
-- return nothing; the local shim grants it nothing at all, which would pass
-- this for the wrong reason. Granting it here first means what gets tested is
-- the policy, which is the thing that has to hold in production.
grant select on public.calendar_accounts to anon;

do $$
begin
  set local role anon;
  perform pg_temp.assert(
    (select count(*) from public.calendar_accounts) = 0,
    'a signed-out request sees no connections, even holding the SELECT grant');
  reset role;
end;
$$;

revoke select on public.calendar_accounts from anon;

-- ---------------------------------------------------------------------------
\echo '== a token is deleted with its connection =='
-- ---------------------------------------------------------------------------
do $$
declare
  temp_account uuid;
begin
  insert into public.calendar_accounts (profile_id, google_email)
  values (pg_temp.profile_id('cal-admin@agency.test'), 'cascade@gmail.test')
  returning id into temp_account;
  insert into public.calendar_credentials (calendar_account_id, access_token_enc)
  values (temp_account, 'v1.sealed');

  delete from public.calendar_accounts where id = temp_account;

  perform pg_temp.assert(
    not exists (select 1 from public.calendar_credentials where calendar_account_id = temp_account),
    'disconnecting takes the stored tokens with it');
end;
$$;

-- ---------------------------------------------------------------------------
\echo '== an edit here has to reach Google =='
-- ---------------------------------------------------------------------------
do $$
declare
  appt uuid;
  account uuid;
begin
  account := pg_temp.account_id('rep@gmail.test');

  insert into public.appointments
    (title, starts_at, calendar_account_id, external_event_id, sync_state)
  values ('Discovery call', now() + interval '2 days', account, 'gcal-1', 'synced')
  returning id into appt;

  -- A field Google carries: the event is now out of date.
  update public.appointments set starts_at = now() + interval '3 days' where id = appt;
  perform pg_temp.assert(
    (select sync_state from public.appointments where id = appt) = 'pending',
    'moving an appointment marks it for pushing');

  update public.appointments set sync_state = 'synced' where id = appt;

  -- A field Google never saw.
  update public.appointments set meeting_notes = 'They mentioned a competitor' where id = appt;
  perform pg_temp.assert(
    (select sync_state from public.appointments where id = appt) = 'synced',
    'writing private notes does not dirty the remote event');

  update public.appointments set attendee_emails = array['owner@practice.test'] where id = appt;
  perform pg_temp.assert(
    (select sync_state from public.appointments where id = appt) = 'pending',
    'changing the attendees does');

  -- An appointment with no calendar attached has nothing to push.
  update public.appointments
     set sync_state = 'local', calendar_account_id = null where id = appt;
  update public.appointments set title = 'Renamed' where id = appt;
  perform pg_temp.assert(
    (select sync_state from public.appointments where id = appt) = 'local',
    'an unlinked appointment is never queued');

  delete from public.appointments where id = appt;
end;
$$;

-- ---------------------------------------------------------------------------
\echo '== deletes outlive the row =='
-- ---------------------------------------------------------------------------
do $$
declare
  appt uuid;
  account uuid;
begin
  account := pg_temp.account_id('rep@gmail.test');
  delete from public.calendar_deletions;

  insert into public.appointments
    (title, starts_at, calendar_account_id, external_event_id, sync_state)
  values ('Call to cancel', now() + interval '1 day', account, 'gcal-doomed', 'synced')
  returning id into appt;

  delete from public.appointments where id = appt;

  -- By the time the sync runs the row, and its external_event_id, are gone.
  perform pg_temp.assert(
    exists (select 1 from public.calendar_deletions
             where external_event_id = 'gcal-doomed'
               and calendar_account_id = account
               and calendar_id = 'primary'),
    'deleting an appointment queues the Google event for removal');

  -- Nothing to remove when it was never on a calendar.
  insert into public.appointments (title, starts_at)
  values ('CRM only', now() + interval '1 day') returning id into appt;
  delete from public.appointments where id = appt;

  perform pg_temp.assert(
    (select count(*) from public.calendar_deletions) = 1,
    'an appointment that was never synced queues nothing');

  delete from public.calendar_deletions;
end;
$$;

\echo ''
\echo '=========================================='
\echo ' ALL CALENDAR SYNC TESTS PASSED'
\echo '=========================================='

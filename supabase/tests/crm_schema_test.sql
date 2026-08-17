-- ============================================================================
-- Behavioural tests for the Agency CRM schema.
--
--   psql -d <db> -v ON_ERROR_STOP=1 -f supabase/tests/auth_shim.sql
--   psql -d <db> -v ON_ERROR_STOP=1 -f supabase/migrations/20260815_create_agency_crm.sql
--   psql -d <db> -v ON_ERROR_STOP=1 -f supabase/tests/crm_schema_test.sql
--
-- Any failed assertion raises and aborts the run.
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

-- ---------------------------------------------------------------------------
\echo '== structure =='
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
  expected text[] := array[
    'profiles', 'crm_leads', 'lead_intelligence', 'contacts', 'activities',
    'outreach_sequences', 'outreach_steps', 'lead_outreach', 'tasks',
    'appointments', 'opportunities', 'proposals', 'clients', 'contracts',
    'payments', 'notes', 'documents', 'pipeline_stage_history'
  ];
begin
  foreach t in array expected loop
    perform pg_temp.assert(
      to_regclass('public.' || t) is not null, format('table %s exists', t));
    perform pg_temp.assert(
      (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass),
      format('RLS enabled on %s', t));
  end loop;
end;
$$;

-- Indexes the spec calls for explicitly.
do $$
declare
  idx text;
  expected text[] := array[
    'crm_leads_pipeline_stage_idx', 'crm_leads_owner_id_idx',
    'crm_leads_next_action_at_idx', 'activities_crm_lead_id_idx',
    'activities_occurred_at_idx', 'tasks_due_at_idx',
    'appointments_starts_at_idx', 'opportunities_stage_idx',
    'payments_status_idx', 'payments_due_at_idx'
  ];
begin
  foreach idx in array expected loop
    perform pg_temp.assert(
      exists (select 1 from pg_indexes where schemaname = 'public' and indexname = idx),
      format('index %s exists', idx));
  end loop;
end;
$$;

-- Every foreign key column should be indexed, or joins degrade silently.
do $$
declare
  missing text;
begin
  select string_agg(format('%s.%s', c.conrelid::regclass, a.attname), ', ')
    into missing
  from pg_constraint c
  join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
  where c.contype = 'f'
    and c.connamespace = 'public'::regnamespace
    and array_length(c.conkey, 1) = 1
    and not exists (
      select 1 from pg_index i
      where i.indrelid = c.conrelid and c.conkey[1] = i.indkey[0]
    );
  perform pg_temp.assert(missing is null, coalesce('unindexed FKs: ' || missing, 'all FK columns indexed'));
end;
$$;

-- ---------------------------------------------------------------------------
\echo '== updated_at trigger =='
-- ---------------------------------------------------------------------------
-- set_updated_at() uses now(), which is the TRANSACTION timestamp, so this has
-- to span separate transactions to observe it move. Each top-level psql
-- statement is its own transaction.
do $$
declare
  uid uuid;
begin
  insert into auth.users (email) values ('owner@agency.test') returning id into uid;
  update public.profiles set role = 'owner', full_name = 'Agency Owner' where id = uid;
  perform pg_temp.assert(
    (select count(*) from public.profiles where id = uid) = 1,
    'auth.users insert auto-creates a profile');

  insert into public.crm_leads (external_lead_id, owner_id) values ('ext_updated_at', uid);
end;
$$;

create temp table _updated_at_probe as
  select updated_at as before_ts from public.crm_leads where external_lead_id = 'ext_updated_at';

update public.crm_leads set next_action = 'Call them' where external_lead_id = 'ext_updated_at';

do $$
declare
  prior timestamptz; after_ts timestamptz;
begin
  select before_ts into prior from _updated_at_probe;
  select updated_at into after_ts from public.crm_leads where external_lead_id = 'ext_updated_at';
  perform pg_temp.assert(after_ts > prior, 'updated_at advances on UPDATE');
end;
$$;

-- ---------------------------------------------------------------------------
\echo '== external_lead_id uniqueness (sync idempotency) =='
-- ---------------------------------------------------------------------------
do $$
declare
  duplicated boolean := false;
begin
  begin
    insert into public.crm_leads (external_lead_id) values ('ext_updated_at');
    duplicated := true;
  exception when unique_violation then
    duplicated := false;
  end;
  perform pg_temp.assert(not duplicated, 'duplicate external_lead_id is rejected');
end;
$$;

-- ON CONFLICT upsert is the shape the sync uses: it must not disturb CRM state.
do $$
declare
  lead_id uuid; stage crm_pipeline_stage; owner uuid;
begin
  select id into lead_id from public.crm_leads where external_lead_id = 'ext_updated_at';
  update public.crm_leads set pipeline_stage = 'appointment_booked' where id = lead_id;
  select owner_id into owner from public.crm_leads where id = lead_id;

  -- Re-sync of the same external lead.
  insert into public.crm_leads (external_lead_id, pipeline_stage)
  values ('ext_updated_at', 'qualified')
  on conflict (external_lead_id) do update set updated_at = now();

  select pipeline_stage into stage from public.crm_leads where external_lead_id = 'ext_updated_at';
  perform pg_temp.assert(stage = 'appointment_booked', 'a re-sync does not reset pipeline_stage');
  perform pg_temp.assert(
    (select owner_id from public.crm_leads where id = lead_id) = owner,
    'a re-sync does not clear owner_id');
  perform pg_temp.assert(
    (select count(*) from public.crm_leads where external_lead_id = 'ext_updated_at') = 1,
    'a re-sync creates no duplicate row');
end;
$$;

-- ---------------------------------------------------------------------------
\echo '== pipeline stage history =='
-- ---------------------------------------------------------------------------
do $$
declare
  lead_id uuid;
begin
  insert into public.crm_leads (external_lead_id) values ('ext_history') returning id into lead_id;

  perform pg_temp.assert(
    (select count(*) from public.pipeline_stage_history
      where crm_lead_id = lead_id and from_stage is null and to_stage = 'qualified') = 1,
    'creating a lead records its initial stage');

  update public.crm_leads set pipeline_stage = 'contacted' where id = lead_id;
  update public.crm_leads set pipeline_stage = 'replied'   where id = lead_id;

  perform pg_temp.assert(
    (select count(*) from public.pipeline_stage_history where crm_lead_id = lead_id) = 3,
    'each transition appends one history row');
  perform pg_temp.assert(
    exists (select 1 from public.pipeline_stage_history
             where crm_lead_id = lead_id and from_stage = 'contacted' and to_stage = 'replied'),
    'history records both sides of a transition');

  perform pg_temp.assert(
    (select first_contacted_at from public.crm_leads where id = lead_id) is not null,
    'moving to contacted stamps first_contacted_at');
  perform pg_temp.assert(
    (select first_replied_at from public.crm_leads where id = lead_id) is not null,
    'moving to replied stamps first_replied_at');

  -- A no-op update must not pollute the audit trail.
  update public.crm_leads set next_action = 'unchanged stage' where id = lead_id;
  perform pg_temp.assert(
    (select count(*) from public.pipeline_stage_history where crm_lead_id = lead_id) = 3,
    'updating other columns adds no history row');

  update public.crm_leads set pipeline_stage = 'won' where id = lead_id;
  perform pg_temp.assert(
    (select converted_at from public.crm_leads where id = lead_id) is not null,
    'moving to won stamps converted_at');
end;
$$;

-- ---------------------------------------------------------------------------
\echo '== inbound reply halts outreach =='
-- ---------------------------------------------------------------------------
do $$
declare
  lead_id uuid; seq_id uuid;
begin
  insert into public.crm_leads (external_lead_id, pipeline_stage)
  values ('ext_reply', 'contacted') returning id into lead_id;

  insert into public.outreach_sequences (name) values ('6-touch cold') returning id into seq_id;
  insert into public.outreach_steps (sequence_id, step_number, channel, delay_minutes)
  values (seq_id, 1, 'email', 0), (seq_id, 2, 'call', 1440), (seq_id, 3, 'sms', 2880);

  insert into public.lead_outreach (crm_lead_id, sequence_id, status, current_step, next_step_at)
  values (lead_id, seq_id, 'active', 1, now() + interval '1 day');

  -- Outbound activity changes nothing.
  insert into public.activities (crm_lead_id, type, direction, subject)
  values (lead_id, 'email', 'outbound', 'Touch 1');
  perform pg_temp.assert(
    (select status from public.lead_outreach where crm_lead_id = lead_id) = 'active',
    'outbound activity leaves the sequence running');

  -- Inbound reply stops everything.
  insert into public.activities (crm_lead_id, type, direction, subject)
  values (lead_id, 'email', 'inbound', 'Re: Touch 1');

  perform pg_temp.assert(
    (select status from public.lead_outreach where crm_lead_id = lead_id) = 'replied',
    'inbound reply sets outreach status to replied');
  perform pg_temp.assert(
    (select next_step_at from public.lead_outreach where crm_lead_id = lead_id) is null,
    'inbound reply clears the next scheduled step');
  perform pg_temp.assert(
    (select stop_reason from public.lead_outreach where crm_lead_id = lead_id) is not null,
    'inbound reply records a stop reason');
  perform pg_temp.assert(
    (select pipeline_stage from public.crm_leads where id = lead_id) = 'replied',
    'inbound reply advances the lead to replied');
end;
$$;

-- A reply must never drag an advanced lead backwards.
do $$
declare
  lead_id uuid;
begin
  insert into public.crm_leads (external_lead_id, pipeline_stage)
  values ('ext_reply_advanced', 'won') returning id into lead_id;

  insert into public.activities (crm_lead_id, type, direction, subject)
  values (lead_id, 'email', 'inbound', 'Thanks!');

  perform pg_temp.assert(
    (select pipeline_stage from public.crm_leads where id = lead_id) = 'won',
    'inbound reply does not regress a won lead');
end;
$$;

-- ---------------------------------------------------------------------------
\echo '== relationships =='
-- ---------------------------------------------------------------------------
do $$
declare
  lead_id uuid; contact_id uuid; opp_id uuid; client_id uuid; uid uuid;
begin
  select id into uid from public.profiles limit 1;
  insert into public.crm_leads (external_lead_id) values ('ext_rel') returning id into lead_id;

  insert into public.contacts (crm_lead_id, full_name, email, is_primary, is_decision_maker)
  values (lead_id, 'Practice Manager', 'manager@practice.test', true, true)
  returning id into contact_id;

  insert into public.opportunities (crm_lead_id, contact_id, name, stage, monthly_value, setup_fee)
  values (lead_id, contact_id, 'Landing page + Google Ads', 'proposal', 1500, 2000)
  returning id into opp_id;

  insert into public.proposals (opportunity_id, version, status, total_value)
  values (opp_id, 1, 'sent', 20000);

  insert into public.clients (crm_lead_id, opportunity_id, company_name, status, account_owner)
  values (lead_id, opp_id, 'Demo Dental', 'onboarding', uid) returning id into client_id;

  insert into public.contracts (client_id, status, monthly_value) values (client_id, 'signed', 1500);
  insert into public.payments (client_id, opportunity_id, amount, status)
  values (client_id, opp_id, 2000, 'pending');
  insert into public.tasks (crm_lead_id, title, assigned_to) values (lead_id, 'Call ABC Dental', uid);
  insert into public.appointments (crm_lead_id, contact_id, title, starts_at)
  values (lead_id, contact_id, 'Discovery call', now() + interval '2 days');
  insert into public.notes (crm_lead_id, title, content)
  values (lead_id, 'Call notes', '{"type":"doc","content":[]}'::jsonb);
  insert into public.documents (crm_lead_id, name, storage_path)
  values (lead_id, 'audit.pdf', 'leads/ext_rel/audit.pdf');

  perform pg_temp.assert(true, 'lead -> contact -> opportunity -> proposal chain inserts');
  perform pg_temp.assert(true, 'opportunity -> client -> contract -> payment chain inserts');

  -- Cascade: removing the lead removes its dependent CRM records.
  delete from public.crm_leads where id = lead_id;
  perform pg_temp.assert(
    (select count(*) from public.contacts where crm_lead_id = lead_id) = 0,
    'deleting a lead cascades to contacts');
  perform pg_temp.assert(
    (select count(*) from public.opportunities where crm_lead_id = lead_id) = 0,
    'deleting a lead cascades to opportunities');
  -- ... but a client survives, because revenue history must not vanish.
  perform pg_temp.assert(
    (select count(*) from public.clients where id = client_id) = 1,
    'deleting a lead preserves the client record');
end;
$$;

-- One primary contact per lead.
do $$
declare
  lead_id uuid; violated boolean := false;
begin
  insert into public.crm_leads (external_lead_id) values ('ext_primary') returning id into lead_id;
  insert into public.contacts (crm_lead_id, full_name, is_primary) values (lead_id, 'A', true);
  begin
    insert into public.contacts (crm_lead_id, full_name, is_primary) values (lead_id, 'B', true);
    violated := true;
  exception when unique_violation then
    violated := false;
  end;
  perform pg_temp.assert(not violated, 'a lead cannot have two primary contacts');
end;
$$;

-- ---------------------------------------------------------------------------
\echo '== published contact =='
-- ---------------------------------------------------------------------------
do $$
declare
  lead_id uuid;
  stored  record;
begin
  perform pg_temp.assert(
    (select count(*) from information_schema.columns
      where table_schema = 'public' and table_name = 'lead_intelligence'
        and column_name in ('contact_name', 'contact_role', 'contact_source_url')
        and data_type = 'text') = 3,
    'lead_intelligence carries the published contact, its role and its source'
  );

  insert into public.crm_leads (external_lead_id) values ('ext_contact') returning id into lead_id;
  insert into public.lead_intelligence
    (crm_lead_id, external_lead_id, company_name, contact_name, contact_role, contact_source_url)
  values
    (lead_id, 'ext_contact', 'Riverside Dental', 'Helen Carter', 'Managing Director',
     'https://riverside.co.uk/meet-the-team');

  select contact_name, contact_role, contact_source_url into stored
    from public.lead_intelligence where crm_lead_id = lead_id;
  perform pg_temp.assert(stored.contact_name = 'Helen Carter', 'the published contact is stored');
  perform pg_temp.assert(stored.contact_role = 'Managing Director', 'the stated role is stored');
  perform pg_temp.assert(
    stored.contact_source_url like 'https://%',
    'the page the name came from is stored'
  );

  -- A business that publishes nobody must leave all three empty rather than
  -- inheriting a value from anywhere else.
  insert into public.crm_leads (external_lead_id) values ('ext_anon') returning id into lead_id;
  insert into public.lead_intelligence (crm_lead_id, external_lead_id, company_name)
  values (lead_id, 'ext_anon', 'Northern Roofing');
  select contact_name, contact_role into stored
    from public.lead_intelligence where crm_lead_id = lead_id;
  perform pg_temp.assert(
    stored.contact_name is null and stored.contact_role is null,
    'no published contact leaves the columns null'
  );

  perform pg_temp.assert(
    exists (select 1 from pg_indexes where schemaname = 'public'
             and indexname = 'lead_intelligence_contact_name_idx'),
    'named leads are indexed for filtering'
  );
end;
$$;

-- ---------------------------------------------------------------------------
\echo '== document storage =='
-- ---------------------------------------------------------------------------
-- The bucket must be private and its object policies must mirror the CRM's.
-- Getting the table policy right and leaving the object policy open is the
-- classic way to leak files while the database looks locked down.
do $$
begin
  perform pg_temp.assert(
    exists (select 1 from storage.buckets where id = 'crm-documents' and public = false),
    'the crm-documents bucket exists and is private'
  );
  perform pg_temp.assert(
    (select file_size_limit from storage.buckets where id = 'crm-documents') = 26214400,
    'the bucket caps uploads at 25 MiB'
  );
  perform pg_temp.assert(
    (select relrowsecurity from pg_class where oid = 'storage.objects'::regclass),
    'RLS is enabled on storage.objects'
  );
  perform pg_temp.assert(
    exists (select 1 from pg_policies where schemaname = 'storage'
             and tablename = 'objects' and policyname = 'crm_documents_read'),
    'stored files are readable only through a CRM policy'
  );
  perform pg_temp.assert(
    exists (select 1 from pg_policies where schemaname = 'storage'
             and tablename = 'objects' and policyname = 'crm_documents_write'
               and cmd = 'INSERT'),
    'uploads are gated by a CRM policy'
  );
  perform pg_temp.assert(
    exists (select 1 from pg_policies where schemaname = 'storage'
             and tablename = 'objects' and policyname = 'crm_documents_delete'
               and cmd = 'DELETE'),
    'file deletion is gated by a CRM policy'
  );
  perform pg_temp.assert(
    exists (select 1 from pg_indexes where schemaname = 'public'
             and indexname = 'proposals_opportunity_id_idx'),
    'proposals are indexed by opportunity'
  );
  perform pg_temp.assert(
    exists (select 1 from pg_indexes where schemaname = 'public'
             and indexname = 'outreach_steps_sequence_id_idx'),
    'outreach steps are indexed by sequence and order'
  );
end;
$$;

-- Proposal versions are unique per opportunity, which is what lets the version
-- number be derived instead of typed.
do $$
declare
  lead_id uuid; opp_id uuid; violated boolean := false;
begin
  insert into public.crm_leads (external_lead_id) values ('ext_proposal') returning id into lead_id;
  insert into public.opportunities (crm_lead_id, name) values (lead_id, 'Deal')
    returning id into opp_id;
  insert into public.proposals (opportunity_id, version) values (opp_id, 1);
  begin
    insert into public.proposals (opportunity_id, version) values (opp_id, 1);
    violated := true;
  exception when unique_violation then
    violated := false;
  end;
  perform pg_temp.assert(not violated, 'two proposals cannot share a version');

  insert into public.proposals (opportunity_id, version) values (opp_id, 2);
  perform pg_temp.assert(
    (select count(*) from public.proposals where opportunity_id = opp_id) = 2,
    'successive versions coexist'
  );
end;
$$;

-- A sequence a lead is enrolled in must not be deletable: the enrolment row
-- would lose the definition of what it is running.
do $$
declare
  lead_id uuid; seq_id uuid; blocked boolean := false;
begin
  insert into public.crm_leads (external_lead_id) values ('ext_outreach') returning id into lead_id;
  insert into public.outreach_sequences (name) values ('First touch') returning id into seq_id;
  insert into public.outreach_steps (sequence_id, step_number, channel)
    values (seq_id, 1, 'email');
  insert into public.lead_outreach (crm_lead_id, sequence_id) values (lead_id, seq_id);

  begin
    delete from public.outreach_sequences where id = seq_id;
  exception when foreign_key_violation then
    blocked := true;
  end;
  perform pg_temp.assert(blocked, 'a sequence with an enrolled lead cannot be deleted');

  perform pg_temp.assert(
    (select count(*) from public.outreach_steps where sequence_id = seq_id) = 1,
    'its steps are still there'
  );
end;
$$;

-- ---------------------------------------------------------------------------
\echo '== row level security =='
-- ---------------------------------------------------------------------------
-- lead_intelligence and payments must have NO user-facing write policy: the
-- scraped record and Stripe's payment status are service-role territory.
do $$
begin
  perform pg_temp.assert(
    not exists (select 1 from pg_policies where schemaname = 'public'
                 and tablename = 'lead_intelligence' and cmd <> 'SELECT'),
    'lead_intelligence exposes no write policy');
  perform pg_temp.assert(
    not exists (select 1 from pg_policies where schemaname = 'public'
                 and tablename = 'payments' and cmd <> 'SELECT'),
    'payments exposes no write policy (Stripe is the source of truth)');
  perform pg_temp.assert(
    not exists (select 1 from pg_policies where schemaname = 'public'
                 and tablename = 'pipeline_stage_history' and cmd <> 'SELECT'),
    'pipeline_stage_history is append-only from the application''s view');
end;
$$;

-- Live role checks, impersonating real users through auth.uid().
do $$
declare
  sales_id uuid; viewer_id uuid; lead_id uuid; denied boolean;
begin
  insert into auth.users (email) values ('sales@agency.test')  returning id into sales_id;
  insert into auth.users (email) values ('viewer@agency.test') returning id into viewer_id;
  update public.profiles set role = 'sales'  where id = sales_id;
  update public.profiles set role = 'viewer' where id = viewer_id;

  insert into public.crm_leads (external_lead_id) values ('ext_rls') returning id into lead_id;
end;
$$;

do $$
declare
  sales_id uuid; viewer_id uuid; visible int; denied boolean := false;
begin
  select id into sales_id  from public.profiles where role = 'sales'  limit 1;
  select id into viewer_id from public.profiles where role = 'viewer' limit 1;

  -- Impersonate the sales user.
  perform set_config('request.jwt.claim.sub', sales_id::text, true);
  perform set_config('role', 'authenticated', true);

  perform pg_temp.assert(public.crm_is_member(), 'sales user is a member');
  perform pg_temp.assert(public.crm_can_write(), 'sales user may write');
  perform pg_temp.assert(not public.crm_is_admin(), 'sales user is not an admin');

  -- Impersonate the viewer.
  perform set_config('request.jwt.claim.sub', viewer_id::text, true);
  perform pg_temp.assert(public.crm_is_member(), 'viewer is a member');
  perform pg_temp.assert(not public.crm_can_write(), 'viewer may not write');

  -- Anonymous.
  perform set_config('request.jwt.claim.sub', '', true);
  perform pg_temp.assert(not public.crm_is_member(), 'anonymous request is not a member');
  perform pg_temp.assert(not public.crm_can_write(), 'anonymous request may not write');
end;
$$;

-- Enforcement, not just the helper functions: run as the `authenticated` role
-- so the policies actually apply.
do $$
declare
  viewer_id uuid; sales_id uuid; blocked boolean := false; readable int;
begin
  select id into viewer_id from public.profiles where role = 'viewer' limit 1;
  select id into sales_id  from public.profiles where role = 'sales'  limit 1;

  set local role authenticated;

  perform set_config('request.jwt.claim.sub', viewer_id::text, true);
  select count(*) into readable from public.crm_leads;
  perform pg_temp.assert(readable > 0, 'viewer can read crm_leads through RLS');

  begin
    insert into public.crm_leads (external_lead_id) values ('ext_viewer_write');
  exception when insufficient_privilege then
    blocked := true;
  end;
  perform pg_temp.assert(blocked, 'viewer INSERT into crm_leads is blocked by RLS');

  -- lead_intelligence has no write policy for anyone.
  blocked := false;
  perform set_config('request.jwt.claim.sub', sales_id::text, true);
  begin
    insert into public.lead_intelligence (crm_lead_id, external_lead_id, company_name)
    values ((select id from public.crm_leads limit 1), 'ext_hack', 'Hacked Ltd');
  exception when insufficient_privilege then
    blocked := true;
  end;
  perform pg_temp.assert(blocked, 'sales INSERT into lead_intelligence is blocked by RLS');

  -- Sales may create a lead.
  insert into public.crm_leads (external_lead_id) values ('ext_sales_write');
  perform pg_temp.assert(
    exists (select 1 from public.crm_leads where external_lead_id = 'ext_sales_write'),
    'sales INSERT into crm_leads is allowed');

  reset role;
end;
$$;

-- Anonymous callers see nothing.
do $$
declare
  readable int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '', true);
  select count(*) into readable from public.crm_leads;
  perform pg_temp.assert(readable = 0, 'a request with no user sees no leads');
  reset role;
end;
$$;

\echo ''
\echo '=========================================='
\echo ' ALL CRM SCHEMA TESTS PASSED'
\echo '=========================================='

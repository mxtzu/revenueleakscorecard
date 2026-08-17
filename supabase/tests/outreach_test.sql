-- ============================================================================
-- Behavioural tests for the outreach engine schema (20260821_outreach_engine).
--
-- This is the first migration in the project that lets the CRM contact a
-- stranger, so the assertions here are mostly about the things that stop it
-- doing so wrongly:
--
--   * sending is off by default,
--   * a suppression survives the lead being deleted,
--   * suppression matching is case- and format-insensitive,
--   * the send ledger cannot be written or rewritten from the UI,
--   * a step cannot be sent to the same enrolment twice,
--   * an inbound activity stops every live sequence — the existing trigger,
--     re-asserted here because reply detection now depends on it.
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

do $$
declare
  admin_id uuid;
  sales_id uuid;
  lead_id  uuid;
  seq_id   uuid;
begin
  insert into auth.users (email) values ('out-admin@agency.test') returning id into admin_id;
  update public.profiles set role = 'admin' where id = admin_id;

  insert into auth.users (email) values ('out-sales@agency.test') returning id into sales_id;
  update public.profiles set role = 'sales' where id = sales_id;

  insert into auth.users (email) values ('out-viewer@agency.test');
  update public.profiles set role = 'viewer' where email = 'out-viewer@agency.test';

  insert into public.crm_leads (external_lead_id, pipeline_stage)
  values ('outreach_lead', 'ready_for_outreach') returning id into lead_id;

  insert into public.lead_intelligence (crm_lead_id, external_lead_id, company_name, business_email)
  values (lead_id, 'outreach_lead', 'Riverside Dental', 'info@riverside.test');

  insert into public.outreach_sequences (name) values ('Cold email, 3 steps') returning id into seq_id;
  insert into public.outreach_steps (sequence_id, step_number, channel, body_template)
  values (seq_id, 1, 'email', 'Hi {{first_name}}');

  insert into public.lead_outreach (crm_lead_id, sequence_id, status, next_step_at)
  values (lead_id, seq_id, 'active', now());
end;
$$;

create or replace function pg_temp.profile_id(addr text) returns uuid
language sql stable security definer as $$
  select id from public.profiles where email = addr;
$$;

create or replace function pg_temp.lead_id() returns uuid
language sql stable security definer as $$
  select id from public.crm_leads where external_lead_id = 'outreach_lead';
$$;

-- ---------------------------------------------------------------------------
\echo '== sending is off until somebody turns it on =='
-- ---------------------------------------------------------------------------
do $$
begin
  -- Applying this migration to a database full of scraped leads must not start
  -- emailing them the moment a cron job is pointed at the run endpoint.
  perform pg_temp.assert(
    (select sending_enabled from public.outreach_settings) is false,
    'sending_enabled defaults to false');
  perform pg_temp.assert(
    (select count(*) from public.outreach_settings) = 1,
    'there is exactly one settings row');
end;
$$;

do $$
declare rejected boolean := false;
begin
  begin
    insert into public.outreach_settings (id) values (true);
  exception when unique_violation then rejected := true;
  end;
  perform pg_temp.assert(rejected, 'a second settings row cannot be created');

  rejected := false;
  begin
    update public.outreach_settings set send_window_start = 18, send_window_end = 9;
  exception when check_violation then rejected := true;
  end;
  perform pg_temp.assert(rejected, 'the sending window has to end after it starts');
end;
$$;

-- ---------------------------------------------------------------------------
\echo '== suppression =='
-- ---------------------------------------------------------------------------
do $$
begin
  insert into public.suppressions (email, reason)
  values ('  Owner@Practice.CO.UK  ', 'unsubscribed');

  -- "Owner@Practice.co.uk" and "owner@practice.co.uk" are the same inbox. A
  -- suppression that only matches one casing does not work.
  perform pg_temp.assert(
    (select email from public.suppressions where reason = 'unsubscribed') = 'owner@practice.co.uk',
    'an email is lower-cased and trimmed on the way in');

  perform pg_temp.assert(
    public.crm_is_suppressed('OWNER@practice.co.uk', null),
    'the gate matches whatever casing it is asked about');
  perform pg_temp.assert(
    not public.crm_is_suppressed('someone.else@practice.co.uk', null),
    'and does not match a different address');
end;
$$;

do $$
begin
  insert into public.suppressions (phone, reason) values ('+44 7700 900 222', 'manual');

  perform pg_temp.assert(
    (select phone from public.suppressions where reason = 'manual') = '+447700900222',
    'a phone number keeps only its digits');
  perform pg_temp.assert(
    public.crm_is_suppressed(null, '+44 (0)7700-900222') = false,
    'a differently punctuated number with extra digits is a different number');
  perform pg_temp.assert(
    public.crm_is_suppressed(null, '+44 7700 900222'),
    'the same number written differently still matches');
end;
$$;

do $$
declare rejected boolean := false;
begin
  begin
    insert into public.suppressions (email, reason) values ('owner@practice.co.uk', 'bounced');
  exception when unique_violation then rejected := true;
  end;
  perform pg_temp.assert(rejected, 'an address appears on the list once');

  rejected := false;
  begin
    insert into public.suppressions (reason) values ('manual');
  exception when check_violation then rejected := true;
  end;
  perform pg_temp.assert(rejected, 'a suppression needs an address or a number');
end;
$$;

/**
 * The one that matters most: deleting a lead must not resurrect permission to
 * email them.
 */
do $$
declare temp_lead uuid;
begin
  insert into public.crm_leads (external_lead_id) values ('temp_for_suppression')
  returning id into temp_lead;
  insert into public.suppressions (email, reason, crm_lead_id)
  values ('gone@example.test', 'unsubscribed', temp_lead);

  delete from public.crm_leads where id = temp_lead;

  perform pg_temp.assert(
    public.crm_is_suppressed('gone@example.test', null),
    'a suppression outlives the lead it came from');
  perform pg_temp.assert(
    (select crm_lead_id from public.suppressions where email = 'gone@example.test') is null,
    'and simply loses the link');
end;
$$;

-- ---------------------------------------------------------------------------
\echo '== the send ledger is a record, not a field =='
-- ---------------------------------------------------------------------------
do $$
begin
  perform pg_temp.assert(
    not exists (select 1 from pg_policies
                 where schemaname = 'public' and tablename = 'outreach_messages'
                   and cmd in ('INSERT', 'UPDATE', 'DELETE')),
    'outreach_messages exposes no write policy');
  perform pg_temp.assert(
    not exists (select 1 from pg_policies
                 where schemaname = 'public' and tablename = 'inbound_messages'
                   and cmd in ('INSERT', 'UPDATE', 'DELETE')),
    'inbound_messages exposes no write policy');
  perform pg_temp.assert(
    not exists (select 1 from pg_policies
                 where schemaname = 'public' and tablename = 'provider_events'),
    'provider_events has NO policies at all');
end;
$$;

do $$
declare refused boolean;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', pg_temp.profile_id('out-admin@agency.test')::text, true);

  refused := false;
  begin
    insert into public.outreach_messages (crm_lead_id, channel, status)
    values (pg_temp.lead_id(), 'email', 'sent');
  exception when others then refused := true;
  end;
  perform pg_temp.assert(refused, 'an admin cannot fabricate a sent message');

  refused := false;
  begin
    insert into public.inbound_messages (crm_lead_id, channel, body)
    values (pg_temp.lead_id(), 'email', 'a reply that never happened');
  exception when others then refused := true;
  end;
  perform pg_temp.assert(refused, 'an admin cannot fabricate a reply');

  perform pg_temp.assert(
    (select count(*) from public.provider_events) = 0,
    'nobody can read the webhook ledger');

  reset role;
end;
$$;

-- ---------------------------------------------------------------------------
\echo '== a step is sent once =='
-- ---------------------------------------------------------------------------
do $$
declare
  enrol_id uuid;
  step_id  uuid;
  rejected boolean := false;
begin
  select id into enrol_id from public.lead_outreach where crm_lead_id = pg_temp.lead_id();
  select id into step_id from public.outreach_steps where step_number = 1 limit 1;

  insert into public.outreach_messages
    (lead_outreach_id, crm_lead_id, step_id, channel, status)
  values (enrol_id, pg_temp.lead_id(), step_id, 'email', 'sent');

  begin
    insert into public.outreach_messages
      (lead_outreach_id, crm_lead_id, step_id, channel, status)
    values (enrol_id, pg_temp.lead_id(), step_id, 'email', 'sent');
  exception when unique_violation then rejected := true;
  end;

  -- Two overlapping engine runs race on this index rather than both emailing.
  perform pg_temp.assert(rejected, 'the same step cannot be sent twice to one enrolment');
end;
$$;

do $$
declare rejected boolean := false;
begin
  begin
    insert into public.outreach_messages (channel, status, provider, provider_message_id)
    values ('email', 'sent', 'resend', 'dup-1');
    insert into public.outreach_messages (channel, status, provider, provider_message_id)
    values ('email', 'sent', 'resend', 'dup-1');
  exception when unique_violation then rejected := true;
  end;
  perform pg_temp.assert(rejected, 'a redelivered provider callback cannot duplicate a row');
end;
$$;

-- ---------------------------------------------------------------------------
\echo '== unsubscribe tokens =='
-- ---------------------------------------------------------------------------
do $$
declare
  token_a text;
  token_b text;
  other_lead uuid;
  other_seq uuid;
begin
  select unsubscribe_token into token_a
    from public.lead_outreach where crm_lead_id = pg_temp.lead_id();

  insert into public.crm_leads (external_lead_id) values ('second_lead') returning id into other_lead;
  insert into public.outreach_sequences (name) values ('Second sequence') returning id into other_seq;
  insert into public.lead_outreach (crm_lead_id, sequence_id)
  values (other_lead, other_seq)
  returning unsubscribe_token into token_b;

  perform pg_temp.assert(length(token_a) >= 32, 'the token is long enough not to be guessed');
  perform pg_temp.assert(token_a <> token_b, 'every enrolment gets its own token');
  -- A URL carrying a lead id would let anyone unsubscribe anyone by counting.
  perform pg_temp.assert(token_a !~ '-', 'the token is opaque, not a uuid');
end;
$$;

-- ---------------------------------------------------------------------------
\echo '== a reply stops the sequence =='
-- ---------------------------------------------------------------------------
/**
 * Reply detection is this trigger, written in the first migration. Sprint 6
 * feeds it from the inbound webhook rather than reimplementing the rule, so it
 * is re-asserted here: if it stopped working, replies would be recorded and
 * sequences would keep sending.
 */
do $$
declare enrol_status crm_outreach_status;
begin
  perform pg_temp.assert(
    (select status from public.lead_outreach where crm_lead_id = pg_temp.lead_id()) = 'active',
    'the enrolment starts active');

  insert into public.activities (crm_lead_id, type, direction, body)
  values (pg_temp.lead_id(), 'email', 'inbound', 'Yes, Thursday works.');

  select status into enrol_status
    from public.lead_outreach where crm_lead_id = pg_temp.lead_id();

  perform pg_temp.assert(enrol_status = 'replied', 'an inbound email stops the sequence');
  perform pg_temp.assert(
    (select next_step_at from public.lead_outreach where crm_lead_id = pg_temp.lead_id()) is null,
    'and unschedules the next step');
  perform pg_temp.assert(
    (select pipeline_stage from public.crm_leads where id = pg_temp.lead_id()) = 'replied',
    'and moves the lead to replied');
end;
$$;

do $$
declare temp_lead uuid; temp_seq uuid;
begin
  -- An outbound message must not look like a reply. The engine logs sends as
  -- `outbound` for exactly this reason.
  insert into public.crm_leads (external_lead_id, pipeline_stage)
  values ('outbound_only', 'ready_for_outreach') returning id into temp_lead;
  insert into public.outreach_sequences (name) values ('Outbound test') returning id into temp_seq;
  insert into public.lead_outreach (crm_lead_id, sequence_id, status, next_step_at)
  values (temp_lead, temp_seq, 'active', now());

  insert into public.activities (crm_lead_id, type, direction, body)
  values (temp_lead, 'email', 'outbound', 'Step 1 going out.');

  perform pg_temp.assert(
    (select status from public.lead_outreach where crm_lead_id = temp_lead) = 'active',
    'sending a message does not stop the sequence that sent it');
end;
$$;

-- ---------------------------------------------------------------------------
\echo '== who can change what =='
-- ---------------------------------------------------------------------------
do $$
declare refused boolean;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', pg_temp.profile_id('out-sales@agency.test')::text, true);

  -- "Never contact this address again" is a request anyone should be able to
  -- honour immediately, without finding an admin.
  insert into public.suppressions (email, reason) values ('sales-added@example.test', 'manual');
  perform pg_temp.assert(
    public.crm_is_suppressed('sales-added@example.test', null),
    'a sales user can add to the do-not-contact list');

  -- Removing one is what puts an address back in the send path.
  delete from public.suppressions where email = 'sales-added@example.test';
  perform pg_temp.assert(
    public.crm_is_suppressed('sales-added@example.test', null),
    'and cannot remove one');

  -- Turning sending on is not a decision for whoever happens to be logged in.
  update public.outreach_settings set sending_enabled = true;
  perform pg_temp.assert(
    (select sending_enabled from public.outreach_settings) is false,
    'a sales user cannot switch sending on');

  reset role;
end;
$$;

do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', pg_temp.profile_id('out-admin@agency.test')::text, true);

  update public.outreach_settings set sending_enabled = true;
  perform pg_temp.assert(
    (select sending_enabled from public.outreach_settings) is true,
    'an admin can switch sending on');

  delete from public.suppressions where email = 'sales-added@example.test';
  perform pg_temp.assert(
    not public.crm_is_suppressed('sales-added@example.test', null),
    'and can remove a suppression');

  update public.outreach_settings set sending_enabled = false;
  reset role;
end;
$$;

do $$
declare refused boolean := false;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', pg_temp.profile_id('out-viewer@agency.test')::text, true);

  begin
    insert into public.suppressions (email, reason) values ('viewer@example.test', 'manual');
  exception when others then refused := true;
  end;
  perform pg_temp.assert(refused, 'a viewer cannot write to the do-not-contact list');

  reset role;
end;
$$;

-- ---------------------------------------------------------------------------
\echo '== the suppression check is not an enumeration oracle =='
-- ---------------------------------------------------------------------------
/**
 * Found in the Sprint 7 security review. `crm_is_suppressed` is SECURITY
 * DEFINER, and Postgres grants EXECUTE to PUBLIC by default — so anyone holding
 * the anon key, which is in the browser bundle, could ask whether a named
 * person is on this agency's do-not-contact list.
 */
do $$
begin
  perform pg_temp.assert(
    not has_function_privilege('anon', 'public.crm_is_suppressed(text, text)', 'execute'),
    'anon cannot call crm_is_suppressed');
  perform pg_temp.assert(
    has_function_privilege('authenticated', 'public.crm_is_suppressed(text, text)', 'execute'),
    'a signed-in user still can');
  perform pg_temp.assert(
    has_function_privilege('service_role', 'public.crm_is_suppressed(text, text)', 'execute'),
    'and so can the send path');
end;
$$;

do $$
declare refused boolean := false;
begin
  set local role anon;
  begin
    perform public.crm_is_suppressed('owner@practice.co.uk', null);
  exception when insufficient_privilege then refused := true;
  end;
  reset role;
  perform pg_temp.assert(refused, 'and an anonymous attempt is actually refused');
end;
$$;

\echo ''
\echo '=========================================='
\echo ' ALL OUTREACH TESTS PASSED'
\echo '=========================================='

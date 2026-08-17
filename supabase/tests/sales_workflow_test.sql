-- ============================================================================
-- Behavioural tests for the sales workflow functions (20260818_sales_workflow).
--
-- Run by supabase/tests/run.sh after crm_schema_test.sql. Any failed assertion
-- raises and aborts.
--
-- Everything here runs as `authenticated` with an impersonated user, because
-- the functions are SECURITY INVOKER: running them as the superuser bypasses
-- RLS and would test something the application never does.
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

-- Fixtures. Created as superuser so the tests start from a known state; every
-- assertion below then runs through RLS as a real role.
do $$
declare
  sales_id uuid;
begin
  insert into auth.users (email) values ('workflow-sales@agency.test')
    returning id into sales_id;
  update public.profiles set role = 'sales', full_name = 'Workflow Sales'
   where id = sales_id;

  insert into auth.users (email) values ('workflow-viewer@agency.test');
  update public.profiles set role = 'viewer' where email = 'workflow-viewer@agency.test';
end;
$$;

-- Read the ids BEFORE switching role. Under `authenticated` with no JWT claim
-- set yet, RLS on `profiles` hides every row, so looking them up after the
-- switch silently yields NULL and impersonation quietly does not happen.
create or replace function pg_temp.sales_id() returns uuid language sql stable
security definer as $$
  select id from public.profiles where email = 'workflow-sales@agency.test';
$$;

create or replace function pg_temp.viewer_id() returns uuid language sql stable
security definer as $$
  select id from public.profiles where email = 'workflow-viewer@agency.test';
$$;

-- A fresh lead with intelligence attached, named so tests do not collide.
create or replace function pg_temp.new_lead(tag text)
returns uuid language plpgsql as $$
declare v_id uuid;
begin
  insert into public.crm_leads (external_lead_id, pipeline_stage)
  values ('wf_' || tag, 'qualified')
  returning id into v_id;

  insert into public.lead_intelligence (crm_lead_id, external_lead_id, company_name)
  values (v_id, 'wf_' || tag, initcap(replace(tag, '_', ' ')) || ' Ltd');

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
\echo '== stage ranking =='
-- ---------------------------------------------------------------------------
do $$
begin
  perform pg_temp.assert(
    public.crm_stage_rank('qualified') < public.crm_stage_rank('contacted')
    and public.crm_stage_rank('contacted') < public.crm_stage_rank('proposal')
    and public.crm_stage_rank('proposal') < public.crm_stage_rank('won'),
    'the ladder runs qualified -> contacted -> proposal -> won');

  -- The enum's own ordering puts `lost` after `won`, which would make "further
  -- along" true of a dead lead. This is the reason the rank is explicit.
  perform pg_temp.assert(
    public.crm_stage_rank('lost') = 0
    and public.crm_stage_rank('disqualified') = 0
    and public.crm_stage_rank('do_not_contact') = 0,
    'closed stages sit off the ladder at 0');

  perform pg_temp.assert(
    public.crm_lead_stage_for_opportunity('discovery') = 'sales_call'
    and public.crm_lead_stage_for_opportunity('negotiation') = 'negotiation'
    and public.crm_lead_stage_for_opportunity('won') = 'won',
    'an opportunity stage maps to the lead stage it implies');
end;
$$;

-- ---------------------------------------------------------------------------
\echo '== forward-only advancement =='
-- ---------------------------------------------------------------------------
do $$
declare
  lead_id uuid;
  result  crm_pipeline_stage;
begin
  lead_id := pg_temp.new_lead('advance');

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', pg_temp.sales_id()::text, true);

  result := public.crm_advance_lead_stage(lead_id, 'proposal');
  perform pg_temp.assert(result = 'proposal', 'a lead advances to a later stage');

  result := public.crm_advance_lead_stage(lead_id, 'contacted');
  perform pg_temp.assert(result = 'proposal', 'an earlier stage is ignored, not applied');
  perform pg_temp.assert(
    (select pipeline_stage from public.crm_leads where id = lead_id) = 'proposal',
    'the lead really is still at proposal');

  -- A late-logged discovery call must not resurrect a dead lead.
  update public.crm_leads set pipeline_stage = 'lost' where id = lead_id;
  result := public.crm_advance_lead_stage(lead_id, 'negotiation');
  perform pg_temp.assert(result = 'lost', 'a closed lead is never silently reopened');

  perform pg_temp.assert(
    public.crm_advance_lead_stage(gen_random_uuid(), 'won') is null,
    'advancing a lead that does not exist returns null rather than raising');

  reset role;
end;
$$;

-- ---------------------------------------------------------------------------
\echo '== lead -> opportunity =='
-- ---------------------------------------------------------------------------
do $$
declare
  lead_id  uuid;
  other_id uuid;
  contact_id uuid;
  foreign_contact_id uuid;
  opp_id   uuid;
  act      public.activities;
  rejected boolean;
begin
  lead_id  := pg_temp.new_lead('convert');
  other_id := pg_temp.new_lead('convert_other');

  insert into public.contacts (crm_lead_id, full_name) values (lead_id, 'Dana Okafor')
    returning id into contact_id;
  insert into public.contacts (crm_lead_id, full_name) values (other_id, 'Someone Else')
    returning id into foreign_contact_id;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', pg_temp.sales_id()::text, true);

  opp_id := public.crm_convert_lead_to_opportunity(
    p_lead_id       => lead_id,
    p_name          => '  Landing page + Google Ads  ',
    p_contact_id    => contact_id,
    p_service_name  => 'Landing page',
    p_monthly_value => 1500,
    p_setup_fee     => 2000,
    p_pain_points   => 'No tracking on the current site',
    p_note          => 'Discovery call went well');

  perform pg_temp.assert(opp_id is not null, 'converting a lead returns the new opportunity id');
  perform pg_temp.assert(
    (select name from public.opportunities where id = opp_id) = 'Landing page + Google Ads',
    'the opportunity name is trimmed');
  perform pg_temp.assert(
    (select owner_id from public.opportunities where id = opp_id) = pg_temp.sales_id(),
    'the converter owns the deal when no owner is named');
  perform pg_temp.assert(
    (select pipeline_stage from public.crm_leads where id = lead_id) = 'sales_call',
    'the lead moves to sales_call, so the board matches the forecast');

  select * into act from public.activities
   where crm_lead_id = lead_id and type = 'status_change'
   order by created_at desc limit 1;

  perform pg_temp.assert(act.direction = 'internal',
    'the conversion activity is internal, so it cannot read as a reply');
  perform pg_temp.assert(act.metadata->>'opportunity_id' = opp_id::text,
    'the activity records which opportunity it opened');
  perform pg_temp.assert(act.body = 'Discovery call went well',
    'the note is kept on the activity');

  -- A contact from a different lead is two valid rows, so no FK catches it.
  rejected := false;
  begin
    perform public.crm_convert_lead_to_opportunity(
      p_lead_id => lead_id, p_name => 'Wrong contact', p_contact_id => foreign_contact_id);
  exception when others then
    rejected := sqlerrm like '%does not belong to this lead%';
  end;
  perform pg_temp.assert(rejected, 'a contact belonging to another lead is refused');

  rejected := false;
  begin
    perform public.crm_convert_lead_to_opportunity(p_lead_id => lead_id, p_name => '   ');
  exception when others then
    rejected := sqlerrm like '%needs a name%';
  end;
  perform pg_temp.assert(rejected, 'a blank opportunity name is refused');

  -- One lead, several deals: nothing here pretends otherwise.
  perform public.crm_convert_lead_to_opportunity(
    p_lead_id => lead_id, p_name => 'Meta Ads, spring');
  perform pg_temp.assert(
    (select count(*) from public.opportunities where crm_lead_id = lead_id) = 2,
    'a lead may carry more than one opportunity');

  reset role;
end;
$$;

-- ---------------------------------------------------------------------------
\echo '== proposal sent =='
-- ---------------------------------------------------------------------------
do $$
declare
  lead_id  uuid;
  opp_id   uuid;
  prop_id  uuid;
  first_sent timestamptz;
  act      public.activities;
begin
  lead_id := pg_temp.new_lead('proposal');

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', pg_temp.sales_id()::text, true);

  opp_id := public.crm_convert_lead_to_opportunity(
    p_lead_id => lead_id, p_name => 'Ads retainer');

  insert into public.proposals (opportunity_id, version, title, total_value)
  values (opp_id, 1, 'Ads retainer proposal', 3500)
  returning id into prop_id;

  perform public.crm_send_proposal(prop_id);

  select sent_at into first_sent from public.proposals where id = prop_id;

  perform pg_temp.assert(
    (select status from public.proposals where id = prop_id) = 'sent',
    'the proposal is marked sent');
  perform pg_temp.assert(first_sent is not null, 'sent_at is stamped');
  perform pg_temp.assert(
    (select stage from public.opportunities where id = opp_id) = 'proposal',
    'the deal moves to proposal');
  perform pg_temp.assert(
    (select pipeline_stage from public.crm_leads where id = lead_id) = 'proposal',
    'the lead moves to proposal');

  select * into act from public.activities
   where crm_lead_id = lead_id and type = 'proposal' order by created_at desc limit 1;
  perform pg_temp.assert(act.direction = 'outbound',
    'sending a document to a prospect is recorded as outbound');
  perform pg_temp.assert(act.subject like '%v1%', 'the activity names the version');

  -- Re-sending must not rewrite the date it first went out.
  perform pg_temp.assert(
    (select count(*) from public.activities
      where crm_lead_id = lead_id and type = 'proposal') = 1,
    'exactly one send has been logged so far');

  update public.opportunities set stage = 'negotiation' where id = opp_id;
  perform public.crm_send_proposal(prop_id, p_note => 'Revised pricing');

  perform pg_temp.assert(
    (select sent_at from public.proposals where id = prop_id) = first_sent,
    're-sending keeps the original sent_at');
  perform pg_temp.assert(
    (select stage from public.opportunities where id = opp_id) = 'negotiation',
    'a revision during negotiation does not drag the deal backwards');

  reset role;
end;
$$;

-- ---------------------------------------------------------------------------
\echo '== won -> client =='
-- ---------------------------------------------------------------------------
do $$
declare
  lead_id   uuid;
  opp_id    uuid;
  -- Named v_client, not client_id: a variable sharing a column name makes
  -- `where client_id = client_id` a tautology that quietly matches every row.
  v_client  uuid;
  again_id  uuid;
  contract  public.contracts;
  act       public.activities;
begin
  lead_id := pg_temp.new_lead('won');

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', pg_temp.sales_id()::text, true);

  opp_id := public.crm_convert_lead_to_opportunity(
    p_lead_id       => lead_id,
    p_name          => 'Full stack retainer',
    p_monthly_value => 1800,
    p_setup_fee     => 2500);

  v_client := public.crm_win_opportunity(
    p_opportunity_id  => opp_id,
    p_create_contract => true,
    p_contract_end_date => current_date + 365,
    p_note            => 'Signed on the call');

  perform pg_temp.assert(v_client is not null, 'winning returns the new client id');
  perform pg_temp.assert(
    (select company_name from public.clients where id = v_client) = 'Won Ltd',
    'the client is named from the pipeline intelligence, not left untitled');
  perform pg_temp.assert(
    (select crm_lead_id from public.clients where id = v_client) = lead_id,
    'the client is traceable back to the lead');
  perform pg_temp.assert(
    (select stage from public.opportunities where id = opp_id) = 'won'
    and (select won_at from public.opportunities where id = opp_id) is not null
    and (select lost_at from public.opportunities where id = opp_id) is null,
    'the deal is won, stamped, and carries no lost date');
  perform pg_temp.assert(
    (select pipeline_stage from public.crm_leads where id = lead_id) = 'won',
    'the lead is won');
  perform pg_temp.assert(
    (select converted_at from public.crm_leads where id = lead_id) is not null,
    'the funnel timestamp is set by the existing stage trigger');

  select * into contract from public.contracts where contracts.client_id = v_client limit 1;
  perform pg_temp.assert(contract.id is not null,
    'the contract was created in the same transaction');
  perform pg_temp.assert(contract.monthly_value = 1800,
    'contract values default to the deal values rather than being retyped');
  perform pg_temp.assert(contract.setup_fee = 2500, 'including the setup fee');
  perform pg_temp.assert(contract.signed_at is not null,
    'a signed contract is stamped signed');

  select * into act from public.activities
   where activities.client_id = v_client and type = 'status_change'
   order by created_at desc limit 1;
  perform pg_temp.assert(act.direction = 'internal', 'the win is logged as internal bookkeeping');
  perform pg_temp.assert(act.metadata->>'client_id' = v_client::text,
    'the activity records the client it created');
  perform pg_temp.assert(act.metadata->>'contract_id' = contract.id::text,
    'and the contract');

  -- Double-submitting the form must not create a second account.
  again_id := public.crm_win_opportunity(p_opportunity_id => opp_id);
  perform pg_temp.assert(again_id = v_client, 'winning twice returns the same client');
  perform pg_temp.assert(
    (select count(*) from public.clients where opportunity_id = opp_id) = 1,
    'winning twice creates exactly one client');
  perform pg_temp.assert(
    (select count(*) from public.contracts where contracts.client_id = v_client) = 1,
    'and exactly one contract');

  reset role;
end;
$$;

-- A won deal with no contract, and an explicit company name.
do $$
declare
  lead_id uuid; opp_id uuid; v_client uuid;
begin
  lead_id := pg_temp.new_lead('won_nocontract');

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', pg_temp.sales_id()::text, true);

  opp_id := public.crm_convert_lead_to_opportunity(p_lead_id => lead_id, p_name => 'Pages only');
  v_client := public.crm_win_opportunity(
    p_opportunity_id => opp_id,
    p_company_name   => 'Trading As Name Ltd',
    p_client_status  => 'active');

  perform pg_temp.assert(
    (select company_name from public.clients where id = v_client) = 'Trading As Name Ltd',
    'an explicit company name wins over the pipeline name');
  perform pg_temp.assert(
    (select status from public.clients where id = v_client) = 'active',
    'the client status is the one chosen');
  perform pg_temp.assert(
    not exists (select 1 from public.contracts where contracts.client_id = v_client),
    'no contract is invented when none was asked for');

  reset role;
end;
$$;

-- ---------------------------------------------------------------------------
\echo '== lost =='
-- ---------------------------------------------------------------------------
do $$
declare
  lead_id  uuid;
  opp_id   uuid;
  second   uuid;
  rejected boolean;
  act      public.activities;
begin
  lead_id := pg_temp.new_lead('lost');

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', pg_temp.sales_id()::text, true);

  opp_id := public.crm_convert_lead_to_opportunity(p_lead_id => lead_id, p_name => 'Ads retainer');

  rejected := false;
  begin
    perform public.crm_lose_opportunity(opp_id, '   ');
  exception when others then
    rejected := sqlerrm like '%needs a reason%';
  end;
  perform pg_temp.assert(rejected, 'a lost deal without a reason is refused');

  rejected := false;
  begin
    perform public.crm_lose_opportunity(opp_id, 'Went elsewhere', true, 'won');
  exception when others then
    rejected := sqlerrm like '%lost, disqualified or do not contact%';
  end;
  perform pg_temp.assert(rejected, 'a lead cannot be "closed" into an open stage');

  -- A second live deal keeps the lead open.
  second := public.crm_convert_lead_to_opportunity(p_lead_id => lead_id, p_name => 'Second bite');
  perform public.crm_lose_opportunity(opp_id, 'Budget pulled', true);

  perform pg_temp.assert(
    (select stage from public.opportunities where id = opp_id) = 'lost'
    and (select loss_reason from public.opportunities where id = opp_id) = 'Budget pulled'
    and (select probability from public.opportunities where id = opp_id) = 0,
    'the deal is lost, with its reason and a zeroed probability');
  perform pg_temp.assert(
    (select pipeline_stage from public.crm_leads where id = lead_id) <> 'lost',
    'a lead with another live deal is not closed');

  select * into act from public.activities
   where crm_lead_id = lead_id and metadata->>'workflow' = 'lose_opportunity'
   order by created_at desc limit 1;
  perform pg_temp.assert((act.metadata->>'lead_closed')::boolean is false,
    'the activity says the lead was left open');

  -- Losing the last one closes it.
  perform public.crm_lose_opportunity(second, 'Chose a cheaper agency', true);
  perform pg_temp.assert(
    (select pipeline_stage from public.crm_leads where id = lead_id) = 'lost',
    'losing the last live deal closes the lead');
  perform pg_temp.assert(
    (select loss_reason from public.crm_leads where id = lead_id) = 'Chose a cheaper agency',
    'the lead carries the reason it was lost');

  reset role;
end;
$$;

-- Disqualifying writes the other reason column.
do $$
declare lead_id uuid; opp_id uuid;
begin
  lead_id := pg_temp.new_lead('disqualified');

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', pg_temp.sales_id()::text, true);

  opp_id := public.crm_convert_lead_to_opportunity(p_lead_id => lead_id, p_name => 'Not a fit');
  perform public.crm_lose_opportunity(opp_id, 'Franchise, no local budget', true, 'disqualified');

  perform pg_temp.assert(
    (select pipeline_stage from public.crm_leads where id = lead_id) = 'disqualified',
    'a lead can be closed as disqualified');
  perform pg_temp.assert(
    (select disqualification_reason from public.crm_leads where id = lead_id)
      = 'Franchise, no local budget'
    and (select loss_reason from public.crm_leads where id = lead_id) is null,
    'disqualifying writes disqualification_reason, not loss_reason');

  reset role;
end;
$$;

-- A won deal that became a client cannot be quietly marked lost.
do $$
declare lead_id uuid; opp_id uuid; rejected boolean := false;
begin
  lead_id := pg_temp.new_lead('lost_after_won');

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', pg_temp.sales_id()::text, true);

  opp_id := public.crm_convert_lead_to_opportunity(p_lead_id => lead_id, p_name => 'Signed deal');
  perform public.crm_win_opportunity(p_opportunity_id => opp_id);

  begin
    perform public.crm_lose_opportunity(opp_id, 'Changed their mind');
  exception when others then
    rejected := sqlerrm like '%already won and converted to a client%';
  end;
  perform pg_temp.assert(rejected,
    'losing a deal that already has a client is refused, not silently orphaning it');
  perform pg_temp.assert(
    (select stage from public.opportunities where id = opp_id) = 'won',
    'the refused call left the deal won');

  reset role;
end;
$$;

-- ---------------------------------------------------------------------------
\echo '== call logging =='
-- ---------------------------------------------------------------------------
do $$
declare
  lead_id uuid; opp_id uuid; act_id uuid; rejected boolean := false;
begin
  lead_id := pg_temp.new_lead('call');

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', pg_temp.sales_id()::text, true);

  opp_id := public.crm_convert_lead_to_opportunity(p_lead_id => lead_id, p_name => 'Discovery');

  act_id := public.crm_log_call(
    p_lead_id        => lead_id,
    p_summary        => 'Spoke to the owner; 40 enquiries a month, no tracking.',
    p_outcome        => 'Proposal requested',
    p_opportunity_id => opp_id,
    p_next_action    => 'Send the proposal',
    p_next_action_at => now() + interval '2 days',
    p_task_title     => 'Draft the proposal',
    p_task_due_at    => now() + interval '1 day');

  perform pg_temp.assert(
    (select type from public.activities where id = act_id) = 'call',
    'the call is on the timeline');
  perform pg_temp.assert(
    (select outcome from public.activities where id = act_id) = 'Proposal requested',
    'the outcome is stored');
  perform pg_temp.assert(
    (select next_action from public.crm_leads where id = lead_id) = 'Send the proposal',
    'the follow-up is written onto the lead');
  perform pg_temp.assert(
    (select next_action from public.opportunities where id = opp_id) = 'Send the proposal',
    'and onto the deal, so the two cannot disagree');
  perform pg_temp.assert(
    exists (select 1 from public.tasks
             where crm_lead_id = lead_id and title = 'Draft the proposal'
               and assigned_to = pg_temp.sales_id()),
    'the follow-up task is created in the same transaction');

  begin
    perform public.crm_log_call(p_lead_id => lead_id, p_summary => '  ');
  exception when others then
    rejected := sqlerrm like '%what was said%';
  end;
  perform pg_temp.assert(rejected, 'an empty call note is refused');

  reset role;
end;
$$;

-- ---------------------------------------------------------------------------
\echo '== atomicity =='
-- ---------------------------------------------------------------------------
-- The reason these are functions at all: a failure part-way through must leave
-- nothing behind. A contact from the wrong lead fails AFTER the opportunity
-- INSERT would have run, so a non-transactional sequence of REST calls would
-- have left the opportunity in place.
do $$
declare
  lead_id uuid; wrong_lead uuid; wrong_contact uuid; before_count int; after_count int;
begin
  lead_id    := pg_temp.new_lead('atomic');
  wrong_lead := pg_temp.new_lead('atomic_other');
  insert into public.contacts (crm_lead_id, full_name) values (wrong_lead, 'Wrong Person')
    returning id into wrong_contact;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', pg_temp.sales_id()::text, true);

  select count(*) into before_count from public.opportunities;
  begin
    perform public.crm_convert_lead_to_opportunity(
      p_lead_id => lead_id, p_name => 'Doomed', p_contact_id => wrong_contact);
  exception when others then null;
  end;
  select count(*) into after_count from public.opportunities;

  perform pg_temp.assert(before_count = after_count,
    'a failed conversion leaves no half-built opportunity behind');
  perform pg_temp.assert(
    (select pipeline_stage from public.crm_leads where id = lead_id) = 'qualified',
    'and leaves the lead where it was');

  reset role;
end;
$$;

-- ---------------------------------------------------------------------------
\echo '== permissions =='
-- ---------------------------------------------------------------------------
do $$
declare
  lead_id uuid; opp_id uuid; refused boolean; leads_before int;
begin
  lead_id := pg_temp.new_lead('permissions');

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', pg_temp.sales_id()::text, true);
  opp_id := public.crm_convert_lead_to_opportunity(p_lead_id => lead_id, p_name => 'Guarded');

  -- Viewer: read-only in RLS, and told so rather than shown "does not exist".
  perform set_config('request.jwt.claim.sub', pg_temp.viewer_id()::text, true);

  refused := false;
  begin
    perform public.crm_convert_lead_to_opportunity(p_lead_id => lead_id, p_name => 'Sneaky');
  exception when insufficient_privilege then
    refused := true;
  end;
  perform pg_temp.assert(refused, 'a viewer cannot open an opportunity');

  refused := false;
  begin
    perform public.crm_win_opportunity(p_opportunity_id => opp_id);
  exception when insufficient_privilege then
    refused := true;
  end;
  perform pg_temp.assert(refused, 'a viewer cannot win a deal into a client');
  perform pg_temp.assert(
    not exists (select 1 from public.clients where opportunity_id = opp_id),
    'and no client was created by the attempt');

  refused := false;
  begin
    perform public.crm_lose_opportunity(opp_id, 'Because I said so');
  exception when insufficient_privilege then
    refused := true;
  end;
  perform pg_temp.assert(refused, 'a viewer cannot lose a deal');

  refused := false;
  begin
    perform public.crm_log_call(p_lead_id => lead_id, p_summary => 'Never happened');
  exception when insufficient_privilege then
    refused := true;
  end;
  perform pg_temp.assert(refused, 'a viewer cannot fabricate a call');

  -- Signed out entirely.
  perform set_config('request.jwt.claim.sub', '', true);
  refused := false;
  begin
    perform public.crm_convert_lead_to_opportunity(p_lead_id => lead_id, p_name => 'Anonymous');
  exception when insufficient_privilege then
    refused := true;
  end;
  perform pg_temp.assert(refused, 'a request with no user is refused');

  reset role;
end;
$$;

-- `anon` must not even hold EXECUTE on the writing functions.
do $$
declare
  fn text;
  writers text[] := array[
    'crm_convert_lead_to_opportunity', 'crm_send_proposal', 'crm_win_opportunity',
    'crm_lose_opportunity', 'crm_log_call', 'crm_advance_lead_stage'
  ];
begin
  foreach fn in array writers loop
    perform pg_temp.assert(
      not exists (
        select 1 from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = fn
          and has_function_privilege('anon', p.oid, 'execute')),
      format('anon holds no EXECUTE on %s', fn));
    perform pg_temp.assert(
      exists (
        select 1 from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = fn
          and has_function_privilege('authenticated', p.oid, 'execute')),
      format('authenticated may call %s', fn));
  end loop;
end;
$$;

-- The functions must be SECURITY INVOKER: as DEFINER they would run as the
-- migration's owner and bypass every policy asserted above.
do $$
declare
  bad text;
begin
  select string_agg(p.proname, ', ') into bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('crm_convert_lead_to_opportunity', 'crm_send_proposal',
                       'crm_win_opportunity', 'crm_lose_opportunity',
                       'crm_log_call', 'crm_advance_lead_stage')
     and p.prosecdef;
  perform pg_temp.assert(bad is null,
    coalesce('workflow functions run as the caller, not the definer: ' || bad,
             'workflow functions run as the caller, not the definer'));
end;
$$;

\echo ''
\echo '=========================================='
\echo ' ALL SALES WORKFLOW TESTS PASSED'
\echo '=========================================='

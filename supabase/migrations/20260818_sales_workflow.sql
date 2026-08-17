-- ============================================================================
-- Sprint 3: the sales workflow, as database transactions.
--
-- Every transition in the sales process touches more than one table:
--
--   lead → opportunity   opportunities INSERT + crm_leads UPDATE + activity
--   proposal sent        proposals + opportunities + crm_leads + activity
--   won                  opportunities + clients + contracts + crm_leads + activity
--   lost                 opportunities + crm_leads + activity
--
-- PostgREST cannot send a transaction. Four sequential REST calls from a
-- server action can fail halfway and leave a won opportunity with no client,
-- or a client whose lead still sits in `sales_call`. Doing the work in a
-- plpgsql function makes each transition one statement from the client's point
-- of view, so it either happens completely or not at all.
--
-- SECURITY INVOKER, deliberately. These functions run as the caller, so every
-- statement inside them is still checked against the same RLS policies a
-- direct write would hit — a viewer calling crm_win_opportunity() is refused
-- by the policy on `opportunities`, not by a check someone remembered to
-- write. SECURITY DEFINER here would hand every signed-in user the ability to
-- create clients, which is exactly the hole RLS exists to close.
--
-- Each one still opens with crm_can_write(). That is not the enforcement — RLS
-- is — it is the error message. Under RLS, `SELECT ... FOR UPDATE` applies the
-- UPDATE policy's USING clause, so a reader's lock finds no rows and the
-- function would otherwise report "that opportunity no longer exists" when the
-- truth is that they are not allowed to change it.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Stage ordering.
--
-- The pipeline enum has an order, but Postgres enum ordering is positional and
-- would make `lost` (position 10) rank above `won` (9). Ranking is explicit so
-- the closed stages sit off the ladder entirely at 0: they are outcomes, not
-- progress.
-- ---------------------------------------------------------------------------
create or replace function public.crm_stage_rank(stage crm_pipeline_stage)
returns integer
language sql
immutable
as $$
  select case stage
    when 'qualified'          then 1
    when 'ready_for_outreach' then 2
    when 'contacted'          then 3
    when 'replied'            then 4
    when 'appointment_booked' then 5
    when 'sales_call'         then 6
    when 'proposal'           then 7
    when 'negotiation'        then 8
    when 'won'                then 9
    else 0  -- lost, disqualified, do_not_contact
  end;
$$;

comment on function public.crm_stage_rank(crm_pipeline_stage) is
  'Progress order for a pipeline stage. Closed stages rank 0 - they are outcomes, not steps.';

-- Raises unless the caller may write. See the header: this exists to produce a
-- truthful message, not to be the gate.
create or replace function public.crm_assert_can_write()
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  if not public.crm_can_write() then
    raise exception 'You do not have permission to change deals.'
      using errcode = 'insufficient_privilege';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Opportunity stage → the lead stage it implies.
--
-- A lead and its opportunity are two views of the same deal and they drift
-- apart the moment one is updated without the other. The board then shows a
-- lead in `sales_call` whose only opportunity is at `negotiation`, and the
-- forecast disagrees with the pipeline.
-- ---------------------------------------------------------------------------
create or replace function public.crm_lead_stage_for_opportunity(stage crm_opportunity_stage)
returns crm_pipeline_stage
language sql
immutable
as $$
  select case stage
    -- Discovery is not "we have not spoken yet": an opportunity exists because
    -- a conversation happened, so the lead is at least at `sales_call`.
    when 'discovery'   then 'sales_call'
    when 'sales_call'  then 'sales_call'
    when 'proposal'    then 'proposal'
    when 'negotiation' then 'negotiation'
    when 'won'         then 'won'
    when 'lost'        then 'lost'
  end::crm_pipeline_stage;
$$;

-- ---------------------------------------------------------------------------
-- Move a lead forward, never backward.
--
-- Called as a side effect of opportunity work, where the caller's intent is
-- "this deal progressed", not "set the lead to exactly this stage". Two rules
-- follow from that:
--
--   * a lead already further along is left alone (logging a late discovery
--     call must not drag a lead back out of `negotiation`), and
--   * a closed lead is never silently reopened. Reviving a lost lead is a
--     decision someone makes on the lead itself.
--
-- Returns the stage the lead ended on, so callers can tell whether it moved.
-- ---------------------------------------------------------------------------
create or replace function public.crm_advance_lead_stage(
  p_lead_id uuid,
  p_target  crm_pipeline_stage
)
returns crm_pipeline_stage
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_current crm_pipeline_stage;
begin
  if p_lead_id is null then
    return null;
  end if;

  -- FOR UPDATE: two people closing the same deal at once would otherwise both
  -- read the old stage and the later write would win on a stale comparison.
  select pipeline_stage into v_current
    from public.crm_leads
   where id = p_lead_id
     for update;

  if not found then
    return null;
  end if;

  if public.crm_stage_rank(v_current) = 0
     or public.crm_stage_rank(p_target) <= public.crm_stage_rank(v_current) then
    return v_current;
  end if;

  update public.crm_leads set pipeline_stage = p_target where id = p_lead_id;
  return p_target;
end;
$$;

-- ---------------------------------------------------------------------------
-- Lead → Opportunity.
--
-- The point at which research becomes a deal. Everything the discovery call
-- established is written onto the opportunity, because that is the record the
-- proposal is built from and the forecast reads.
--
-- Idempotency is deliberately NOT enforced here: one lead can legitimately
-- have several opportunities (a landing page now, ads in the spring), so the
-- caller decides, not the database.
-- ---------------------------------------------------------------------------
create or replace function public.crm_convert_lead_to_opportunity(
  p_lead_id             uuid,
  p_name                text,
  p_stage               crm_opportunity_stage default 'discovery',
  p_contact_id          uuid    default null,
  p_owner_id            uuid    default null,
  p_service_name        text    default null,
  p_setup_fee           numeric default null,
  p_monthly_value       numeric default null,
  p_one_time_value      numeric default null,
  p_contract_months     integer default null,
  p_probability         smallint default null,
  p_expected_close_date date    default null,
  p_pain_points         text    default null,
  p_desired_outcome     text    default null,
  p_budget              text    default null,
  p_objections          text    default null,
  p_next_action         text    default null,
  p_next_action_at      timestamptz default null,
  p_note                text    default null
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_opportunity_id uuid;
  v_lead_stage     crm_pipeline_stage;
begin
  perform public.crm_assert_can_write();

  if p_lead_id is null then
    raise exception 'A lead is required to open an opportunity.';
  end if;
  if coalesce(btrim(p_name), '') = '' then
    raise exception 'An opportunity needs a name.';
  end if;

  -- A contact belonging to a different lead would attach this deal to the
  -- wrong person; the FK cannot catch that because both are valid rows.
  if p_contact_id is not null
     and not exists (select 1 from public.contacts
                      where id = p_contact_id and crm_lead_id = p_lead_id) then
    raise exception 'That contact does not belong to this lead.';
  end if;

  insert into public.opportunities (
    crm_lead_id, contact_id, name, stage, service_name,
    setup_fee, monthly_value, one_time_value, contract_months, probability,
    expected_close_date, pain_points, desired_outcome, budget, objections,
    next_action, next_action_at, owner_id,
    won_at, lost_at
  ) values (
    p_lead_id, p_contact_id, btrim(p_name), p_stage, p_service_name,
    p_setup_fee, p_monthly_value, p_one_time_value, p_contract_months, p_probability,
    p_expected_close_date, p_pain_points, p_desired_outcome, p_budget, p_objections,
    p_next_action, p_next_action_at, coalesce(p_owner_id, auth.uid()),
    case when p_stage = 'won'  then now() end,
    case when p_stage = 'lost' then now() end
  )
  returning id into v_opportunity_id;

  v_lead_stage := public.crm_advance_lead_stage(
    p_lead_id, public.crm_lead_stage_for_opportunity(p_stage));

  -- `internal`: this is bookkeeping, not a message to the lead. An `inbound`
  -- activity would trip halt_outreach_on_inbound_reply and claim they replied.
  insert into public.activities (
    crm_lead_id, contact_id, user_id, type, direction, subject, body, metadata
  ) values (
    p_lead_id, p_contact_id, auth.uid(), 'status_change', 'internal',
    format('Opportunity opened: %s', btrim(p_name)),
    p_note,
    jsonb_build_object(
      'workflow', 'convert_lead_to_opportunity',
      'opportunity_id', v_opportunity_id,
      'opportunity_stage', p_stage,
      'lead_stage', v_lead_stage)
  );

  return v_opportunity_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Proposal sent.
--
-- Marks a proposal as sent and pulls the deal and the lead up to match. It
-- does NOT send anything: the proposal is delivered by a human, out of band,
-- and this records that it happened. Nothing in this CRM contacts a lead.
--
-- Re-running is safe. `sent_at` keeps its original value, so re-sending a
-- proposal does not rewrite the date it first went out.
-- ---------------------------------------------------------------------------
create or replace function public.crm_send_proposal(
  p_proposal_id uuid,
  p_sent_at     timestamptz default null,
  p_note        text default null
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_opportunity_id uuid;
  v_lead_id        uuid;
  v_opp_stage      crm_opportunity_stage;
  v_version        integer;
  v_title          text;
begin
  perform public.crm_assert_can_write();

  select p.opportunity_id, p.version, p.title, o.crm_lead_id, o.stage
    into v_opportunity_id, v_version, v_title, v_lead_id, v_opp_stage
    from public.proposals p
    join public.opportunities o on o.id = p.opportunity_id
   where p.id = p_proposal_id
     for update of p, o;

  if not found then
    raise exception 'That proposal no longer exists.';
  end if;

  update public.proposals
     set status  = 'sent',
         sent_at = coalesce(sent_at, p_sent_at, now())
   where id = p_proposal_id;

  -- Forward-only, same reasoning as the lead ladder: a proposal sent during
  -- negotiation is a revision, and must not drag the deal back a step.
  if v_opp_stage in ('discovery', 'sales_call') then
    update public.opportunities set stage = 'proposal' where id = v_opportunity_id;
  end if;

  perform public.crm_advance_lead_stage(v_lead_id, 'proposal');

  -- `outbound`, because a document genuinely went to the prospect. Type
  -- `proposal` is outside halt_outreach_on_inbound_reply's list in any case.
  insert into public.activities (
    crm_lead_id, user_id, type, direction, subject, body, occurred_at, metadata
  ) values (
    v_lead_id, auth.uid(), 'proposal', 'outbound',
    format('Proposal sent: %s (v%s)', coalesce(v_title, 'Untitled'), v_version),
    p_note,
    coalesce(p_sent_at, now()),
    jsonb_build_object(
      'workflow', 'send_proposal',
      'proposal_id', p_proposal_id,
      'opportunity_id', v_opportunity_id,
      'version', v_version)
  );

  return p_proposal_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Won → Client.
--
-- Closes the deal and creates the account it becomes, optionally with the
-- signed contract, in one transaction. A won opportunity with no client is
-- the failure this exists to prevent: it is invisible on the clients page and
-- still counted in the forecast.
--
-- Idempotent by lookup rather than by constraint. Double-submitting the form
-- returns the client that already exists instead of creating a second one.
-- ---------------------------------------------------------------------------
create or replace function public.crm_win_opportunity(
  p_opportunity_id        uuid,
  p_company_name          text    default null,
  p_client_status         crm_client_status default 'onboarding',
  p_account_owner         uuid    default null,
  p_start_date            date    default null,
  p_renewal_date          date    default null,
  p_create_contract       boolean default false,
  p_contract_status       crm_contract_status default 'signed',
  p_contract_start_date   date    default null,
  p_contract_end_date     date    default null,
  p_contract_monthly_value numeric default null,
  p_contract_setup_fee    numeric default null,
  p_contract_document_url text    default null,
  p_note                  text    default null
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_lead_id      uuid;
  v_opp_name     text;
  v_opp_stage    crm_opportunity_stage;
  v_monthly      numeric;
  v_setup        numeric;
  v_owner        uuid;
  v_client_id    uuid;
  v_company      text;
  v_contract_id  uuid;
begin
  perform public.crm_assert_can_write();

  select crm_lead_id, name, stage, monthly_value, setup_fee, owner_id
    into v_lead_id, v_opp_name, v_opp_stage, v_monthly, v_setup, v_owner
    from public.opportunities
   where id = p_opportunity_id
     for update;

  if not found then
    raise exception 'That opportunity no longer exists.';
  end if;

  -- Already converted: hand back the same client rather than making a second.
  select id into v_client_id
    from public.clients
   where opportunity_id = p_opportunity_id
   limit 1;

  if v_client_id is not null then
    update public.opportunities
       set stage   = 'won',
           won_at  = coalesce(won_at, now()),
           lost_at = null,
           loss_reason = null
     where id = p_opportunity_id
       and stage is distinct from 'won';
    return v_client_id;
  end if;

  -- The company name falls back to the pipeline's, then to the deal name, so
  -- the account is never created as an untitled row.
  v_company := nullif(btrim(coalesce(p_company_name, '')), '');
  if v_company is null then
    select nullif(btrim(company_name), '') into v_company
      from public.lead_intelligence where crm_lead_id = v_lead_id;
  end if;
  v_company := coalesce(v_company, v_opp_name);

  update public.opportunities
     set stage       = 'won',
         won_at      = coalesce(won_at, now()),
         lost_at     = null,
         loss_reason = null,
         probability = 100
   where id = p_opportunity_id;

  insert into public.clients (
    crm_lead_id, opportunity_id, company_name, status,
    account_owner, start_date, renewal_date
  ) values (
    v_lead_id, p_opportunity_id, v_company, p_client_status,
    coalesce(p_account_owner, v_owner, auth.uid()),
    coalesce(p_start_date, current_date),
    p_renewal_date
  )
  returning id into v_client_id;

  if p_create_contract then
    insert into public.contracts (
      client_id, status, start_date, end_date,
      monthly_value, setup_fee, document_url, signed_at
    ) values (
      v_client_id, p_contract_status,
      coalesce(p_contract_start_date, p_start_date, current_date),
      p_contract_end_date,
      coalesce(p_contract_monthly_value, v_monthly),
      coalesce(p_contract_setup_fee, v_setup),
      p_contract_document_url,
      -- Same rule the UI uses: a draft or unsent contract is not signed.
      case when p_contract_status in ('draft', 'sent') then null else now() end
    )
    returning id into v_contract_id;
  end if;

  perform public.crm_advance_lead_stage(v_lead_id, 'won');

  insert into public.activities (
    crm_lead_id, client_id, user_id, type, direction, subject, body, metadata
  ) values (
    v_lead_id, v_client_id, auth.uid(), 'status_change', 'internal',
    format('Deal won: %s', v_opp_name),
    p_note,
    jsonb_build_object(
      'workflow', 'win_opportunity',
      'opportunity_id', p_opportunity_id,
      'client_id', v_client_id,
      'contract_id', v_contract_id)
  );

  return v_client_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Lost.
--
-- A reason is mandatory. "Lost" with no reason is the single most useless row
-- in a CRM: it fills the pipeline report with a number nobody can act on.
--
-- Closing the lead is optional and guarded. A lead with another live deal
-- stays open however many individual opportunities are lost.
-- ---------------------------------------------------------------------------
create or replace function public.crm_lose_opportunity(
  p_opportunity_id uuid,
  p_loss_reason    text,
  p_close_lead     boolean default false,
  p_lead_stage     crm_pipeline_stage default 'lost',
  p_note           text default null
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_lead_id     uuid;
  v_opp_name    text;
  v_client_id   uuid;
  v_lead_closed boolean := false;
  v_open_deals  integer;
begin
  perform public.crm_assert_can_write();

  if coalesce(btrim(p_loss_reason), '') = '' then
    raise exception 'A lost deal needs a reason.';
  end if;
  if p_lead_stage not in ('lost', 'disqualified', 'do_not_contact') then
    raise exception 'A lead can only be closed as lost, disqualified or do not contact.';
  end if;

  select crm_lead_id, name
    into v_lead_id, v_opp_name
    from public.opportunities
   where id = p_opportunity_id
     for update;

  if not found then
    raise exception 'That opportunity no longer exists.';
  end if;

  -- Marking a won deal lost would leave its client account behind with no deal
  -- backing it. Deleting the client silently is worse, so this refuses and
  -- says what to do.
  select id into v_client_id
    from public.clients where opportunity_id = p_opportunity_id limit 1;
  if v_client_id is not null then
    raise exception
      'This deal was already won and converted to a client. Cancel the client account instead.';
  end if;

  update public.opportunities
     set stage       = 'lost',
         lost_at     = coalesce(lost_at, now()),
         won_at      = null,
         loss_reason = btrim(p_loss_reason),
         probability = 0
   where id = p_opportunity_id;

  if p_close_lead and v_lead_id is not null then
    select count(*) into v_open_deals
      from public.opportunities
     where crm_lead_id = v_lead_id
       and id <> p_opportunity_id
       and stage not in ('won', 'lost');

    if v_open_deals = 0 then
      update public.crm_leads
         set pipeline_stage = p_lead_stage,
             loss_reason    = case when p_lead_stage = 'lost'
                                   then btrim(p_loss_reason) else loss_reason end,
             disqualification_reason = case when p_lead_stage <> 'lost'
                                   then btrim(p_loss_reason) else disqualification_reason end
       where id = v_lead_id
         and pipeline_stage <> 'won';
      v_lead_closed := found;
    end if;
  end if;

  insert into public.activities (
    crm_lead_id, user_id, type, direction, subject, body, metadata
  ) values (
    v_lead_id, auth.uid(), 'status_change', 'internal',
    format('Deal lost: %s', v_opp_name),
    coalesce(p_note, btrim(p_loss_reason)),
    jsonb_build_object(
      'workflow', 'lose_opportunity',
      'opportunity_id', p_opportunity_id,
      'loss_reason', btrim(p_loss_reason),
      'lead_closed', v_lead_closed,
      'lead_stage', case when v_lead_closed then p_lead_stage end)
  );

  return p_opportunity_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Log a call outcome.
--
-- The sales call workspace saves notes and books the follow-up in one action;
-- separate REST calls could leave notes recorded with no follow-up task, which
-- is precisely the failure mode a follow-up task exists to prevent.
-- ---------------------------------------------------------------------------
create or replace function public.crm_log_call(
  p_lead_id        uuid,
  p_summary        text,
  p_outcome        text default null,
  p_contact_id     uuid default null,
  p_opportunity_id uuid default null,
  p_occurred_at    timestamptz default null,
  p_direction      crm_activity_direction default 'outbound',
  p_next_action    text default null,
  p_next_action_at timestamptz default null,
  p_task_title     text default null,
  p_task_due_at    timestamptz default null
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_activity_id uuid;
begin
  perform public.crm_assert_can_write();

  if p_lead_id is null then
    raise exception 'A call has to be logged against a lead.';
  end if;
  if coalesce(btrim(p_summary), '') = '' then
    raise exception 'Write down what was said before saving the call.';
  end if;

  insert into public.activities (
    crm_lead_id, contact_id, user_id, type, direction,
    subject, body, outcome, occurred_at, metadata
  ) values (
    p_lead_id, p_contact_id, auth.uid(), 'call', p_direction,
    'Sales call', btrim(p_summary), nullif(btrim(coalesce(p_outcome, '')), ''),
    coalesce(p_occurred_at, now()),
    jsonb_build_object('workflow', 'log_call', 'opportunity_id', p_opportunity_id)
  )
  returning id into v_activity_id;

  if p_next_action is not null and btrim(p_next_action) <> '' then
    update public.crm_leads
       set next_action    = btrim(p_next_action),
           next_action_at = p_next_action_at
     where id = p_lead_id;

    if p_opportunity_id is not null then
      update public.opportunities
         set next_action    = btrim(p_next_action),
             next_action_at = p_next_action_at
       where id = p_opportunity_id;
    end if;
  end if;

  if p_task_title is not null and btrim(p_task_title) <> '' then
    insert into public.tasks (crm_lead_id, title, due_at, assigned_to, created_by)
    values (p_lead_id, btrim(p_task_title), p_task_due_at, auth.uid(), auth.uid());
  end if;

  return v_activity_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Execution grants.
--
-- Postgres grants EXECUTE to PUBLIC by default, which would let `anon` call
-- these. Every statement inside is still RLS-checked so an anonymous call
-- writes nothing, but failing at the door is clearer than failing four
-- statements in.
-- ---------------------------------------------------------------------------
do $$
declare
  fn text;
  signatures text[] := array[
    'public.crm_advance_lead_stage(uuid, crm_pipeline_stage)',
    'public.crm_convert_lead_to_opportunity(uuid, text, crm_opportunity_stage, uuid, uuid, text, numeric, numeric, numeric, integer, smallint, date, text, text, text, text, text, timestamptz, text)',
    'public.crm_send_proposal(uuid, timestamptz, text)',
    'public.crm_win_opportunity(uuid, text, crm_client_status, uuid, date, date, boolean, crm_contract_status, date, date, numeric, numeric, text, text)',
    'public.crm_lose_opportunity(uuid, text, boolean, crm_pipeline_stage, text)',
    'public.crm_log_call(uuid, text, text, uuid, uuid, timestamptz, crm_activity_direction, text, timestamptz, text, timestamptz)'
  ];
begin
  foreach fn in array signatures loop
    execute format('revoke all on function %s from public', fn);
    execute format('grant execute on function %s to authenticated, service_role', fn);
  end loop;
end;
$$;

-- The pure helpers are safe for anyone to call; they read nothing.
grant execute on function public.crm_stage_rank(crm_pipeline_stage)
  to authenticated, anon, service_role;
grant execute on function public.crm_lead_stage_for_opportunity(crm_opportunity_stage)
  to authenticated, anon, service_role;
grant execute on function public.crm_assert_can_write()
  to authenticated, anon, service_role;

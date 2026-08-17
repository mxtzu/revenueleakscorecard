-- ============================================================================
-- Behavioural tests for the billing schema (20260820_payments).
--
-- One rule to prove, and it was in the brief from the beginning:
--
--   THE FRONTEND CANNOT MARK A PAYMENT PAID.
--
-- That is enforced by the *absence* of policies on `payments` and
-- `subscriptions`, which is invisible when reading the migration unless you
-- notice what is not there. A policy added later by accident would open it
-- silently, so the absence is asserted.
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
  owner_id uuid;
  client_id uuid;
begin
  insert into auth.users (email) values ('pay-owner@agency.test') returning id into owner_id;
  update public.profiles set role = 'owner' where id = owner_id;

  insert into auth.users (email) values ('pay-sales@agency.test');
  update public.profiles set role = 'sales' where email = 'pay-sales@agency.test';

  insert into public.clients (company_name, stripe_customer_id, billing_email)
  values ('Riverside Dental', 'cus_riverside', 'accounts@riverside.test')
  returning id into client_id;

  insert into public.subscriptions
    (client_id, stripe_subscription_id, stripe_customer_id, status, amount, currency, interval)
  values (client_id, 'sub_riverside', 'cus_riverside', 'active', 1500, 'gbp', 'month');

  insert into public.payments
    (client_id, stripe_invoice_id, stripe_customer_id, amount, currency, status, stripe_status)
  values (client_id, 'in_riverside_1', 'cus_riverside', 1500, 'gbp', 'pending', 'open');
end;
$$;

create or replace function pg_temp.profile_id(addr text) returns uuid
language sql stable security definer as $$
  select id from public.profiles where email = addr;
$$;

-- ---------------------------------------------------------------------------
\echo '== structure =='
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['subscriptions', 'stripe_events'] loop
    perform pg_temp.assert(to_regclass('public.' || t) is not null, format('table %s exists', t));
    perform pg_temp.assert(
      (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass),
      format('RLS enabled on %s', t));
  end loop;

  perform pg_temp.assert(
    exists (select 1 from information_schema.columns
             where table_name = 'clients' and column_name = 'stripe_customer_id'),
    'clients carry a Stripe customer');
  perform pg_temp.assert(
    exists (select 1 from information_schema.columns
             where table_name = 'payments' and column_name = 'stripe_status'),
    'payments keep Stripe''s own status alongside the CRM reading');
  perform pg_temp.assert(
    exists (select 1 from information_schema.columns
             where table_name = 'payments' and column_name = 'last_event_at'),
    'payments record which event last touched them, so a late delivery can be ignored');
end;
$$;

-- Replays must not duplicate. These indexes are what make that true.
do $$
declare idx text;
begin
  foreach idx in array array[
    'payments_stripe_invoice_idx', 'payments_stripe_intent_idx',
    'clients_stripe_customer_idx'
  ] loop
    perform pg_temp.assert(
      exists (select 1 from pg_indexes where schemaname = 'public' and indexname = idx),
      format('unique index %s exists', idx));
  end loop;

  perform pg_temp.assert(
    exists (select 1 from pg_constraint
             where conname = 'subscriptions_stripe_subscription_id_key'),
    'one row per Stripe subscription');
end;
$$;

do $$
declare rejected boolean := false;
begin
  begin
    insert into public.payments (stripe_invoice_id, amount) values ('in_riverside_1', 99);
  exception when unique_violation then rejected := true;
  end;
  perform pg_temp.assert(rejected, 'a redelivered invoice cannot become a second row');

  rejected := false;
  begin
    insert into public.clients (company_name, stripe_customer_id)
    values ('Impostor Ltd', 'cus_riverside');
  exception when unique_violation then rejected := true;
  end;
  perform pg_temp.assert(rejected, 'two accounts cannot share one Stripe customer');
end;
$$;

-- ---------------------------------------------------------------------------
\echo '== the frontend cannot set payment status =='
-- ---------------------------------------------------------------------------
do $$
begin
  perform pg_temp.assert(
    not exists (select 1 from pg_policies
                 where schemaname = 'public' and tablename = 'payments'
                   and cmd in ('INSERT', 'UPDATE', 'DELETE')),
    'payments exposes no write policy of any kind');
  perform pg_temp.assert(
    not exists (select 1 from pg_policies
                 where schemaname = 'public' and tablename = 'subscriptions'
                   and cmd in ('INSERT', 'UPDATE', 'DELETE')),
    'subscriptions exposes no write policy of any kind');
  perform pg_temp.assert(
    not exists (select 1 from pg_policies
                 where schemaname = 'public' and tablename = 'stripe_events'),
    'stripe_events has NO policies at all');
end;
$$;

-- An owner is the most privileged CRM role there is. Even they cannot do this.
do $$
declare
  refused boolean;
  visible int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', pg_temp.profile_id('pay-owner@agency.test')::text, true);

  select count(*) into visible from public.payments
   where stripe_invoice_id = 'in_riverside_1';
  perform pg_temp.assert(visible = 1, 'an owner can read invoices');

  -- The assertion the whole sprint rests on.
  update public.payments set status = 'paid', paid_at = now();
  perform pg_temp.assert(
    (select status from public.payments where stripe_invoice_id = 'in_riverside_1') = 'pending',
    'an owner cannot mark an invoice paid');

  refused := false;
  begin
    insert into public.payments (stripe_invoice_id, amount, status)
    values ('in_forged', 99999, 'paid');
  exception when others then refused := true;
  end;
  perform pg_temp.assert(refused, 'an owner cannot invent a payment');

  refused := false;
  begin
    insert into public.subscriptions (stripe_subscription_id, status)
    values ('sub_forged', 'active');
  exception when others then refused := true;
  end;
  perform pg_temp.assert(refused, 'an owner cannot invent a subscription');

  update public.subscriptions set amount = 999999;
  perform pg_temp.assert(
    (select amount from public.subscriptions where stripe_subscription_id = 'sub_riverside') = 1500,
    'an owner cannot rewrite what a client is billed');

  reset role;
end;
$$;

do $$
declare visible int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', pg_temp.profile_id('pay-sales@agency.test')::text, true);

  select count(*) into visible from public.subscriptions
   where stripe_subscription_id = 'sub_riverside';
  perform pg_temp.assert(visible = 1, 'a sales user can read retainers');

  select count(*) into visible from public.stripe_events;
  perform pg_temp.assert(visible = 0, 'nobody can read the webhook ledger');

  reset role;
end;
$$;

-- Real Supabase grants `anon` SELECT and relies on RLS; the local shim grants
-- nothing, which would pass for the wrong reason. Granting it first means the
-- policy is what gets tested.
grant select on public.subscriptions to anon;
grant select on public.payments to anon;

do $$
begin
  set local role anon;
  perform pg_temp.assert(
    (select count(*) from public.payments) = 0,
    'a signed-out request sees no invoices, even holding the SELECT grant');
  perform pg_temp.assert(
    (select count(*) from public.subscriptions) = 0,
    'and no retainers');
  reset role;
end;
$$;

revoke select on public.subscriptions from anon;
revoke select on public.payments from anon;

-- ---------------------------------------------------------------------------
\echo '== cascades =='
-- ---------------------------------------------------------------------------
do $$
declare temp_client uuid;
begin
  insert into public.clients (company_name) values ('Temporary Ltd') returning id into temp_client;
  insert into public.subscriptions (client_id, stripe_subscription_id, status)
  values (temp_client, 'sub_temp', 'active');
  insert into public.payments (client_id, stripe_invoice_id, amount)
  values (temp_client, 'in_temp', 100);

  delete from public.clients where id = temp_client;

  perform pg_temp.assert(
    not exists (select 1 from public.subscriptions where stripe_subscription_id = 'sub_temp'),
    'deleting a client takes its retainers with it');
  perform pg_temp.assert(
    not exists (select 1 from public.payments where stripe_invoice_id = 'in_temp'),
    'and its invoices');
end;
$$;

-- A subscription being deleted must not delete the invoices raised under it —
-- those are a financial record that outlives the arrangement.
do $$
declare
  temp_client uuid;
  temp_sub uuid;
begin
  insert into public.clients (company_name) values ('Retained Ltd') returning id into temp_client;
  insert into public.subscriptions (client_id, stripe_subscription_id, status)
  values (temp_client, 'sub_keep', 'active') returning id into temp_sub;
  insert into public.payments (client_id, subscription_id, stripe_invoice_id, amount)
  values (temp_client, temp_sub, 'in_keep', 100);

  delete from public.subscriptions where id = temp_sub;

  perform pg_temp.assert(
    exists (select 1 from public.payments where stripe_invoice_id = 'in_keep'),
    'removing a retainer keeps the invoices raised under it');
  perform pg_temp.assert(
    (select subscription_id from public.payments where stripe_invoice_id = 'in_keep') is null,
    'and simply unlinks them');

  delete from public.clients where id = temp_client;
end;
$$;

\echo ''
\echo '=========================================='
\echo ' ALL PAYMENT TESTS PASSED'
\echo '=========================================='

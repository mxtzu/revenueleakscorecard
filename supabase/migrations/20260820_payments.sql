-- ============================================================================
-- Sprint 5: Stripe billing.
--
-- One rule shapes all of this, and it was in the brief from the start:
--
--   STRIPE IS THE SOURCE OF TRUTH FOR PAYMENT STATUS.
--
-- `payments` has had a SELECT policy and no INSERT or UPDATE policy since the
-- first migration, so no signed-in user - owner included - can mark an invoice
-- paid through PostgREST. `subscriptions` is created here under the same rule.
-- The only writer is the webhook handler, running server-side as the service
-- role, reacting to events Stripe cryptographically signed.
--
-- What the UI can do is *ask Stripe for something*: draft an invoice, send it,
-- void it, start or cancel a subscription. Those are API calls whose result
-- comes back from Stripe and is recorded from Stripe's own response - never
-- from a form field.
--
-- Two more things the schema has to handle, because webhooks are not a queue:
--
--   REPLAYS. Stripe re-delivers events, sometimes days later. `stripe_events`
--   is an idempotency ledger keyed on the event id.
--
--   OUT-OF-ORDER DELIVERY. `invoice.paid` can arrive before
--   `invoice.finalized`. Every mirrored row carries the `created` time of the
--   last event that touched it, and an older event is ignored rather than
--   rolling a paid invoice back to open.
-- ============================================================================

-- Stripe's own subscription statuses, named exactly as Stripe names them. A
-- translated copy would need updating every time Stripe adds one, and the
-- translation is where the bug would be.
create type crm_subscription_status as enum (
  'incomplete', 'incomplete_expired', 'trialing', 'active',
  'past_due', 'canceled', 'unpaid', 'paused'
);

-- ---------------------------------------------------------------------------
-- Clients gain a Stripe customer.
--
-- Unique: two CRM accounts pointing at one Stripe customer would make invoices
-- ambiguous to attribute, and the webhook resolves rows by customer id.
-- ---------------------------------------------------------------------------
alter table public.clients
  add column stripe_customer_id text,
  add column billing_email      text;

create unique index clients_stripe_customer_idx
  on public.clients (stripe_customer_id) where stripe_customer_id is not null;

-- ---------------------------------------------------------------------------
-- subscriptions: a local mirror of Stripe, for reporting and for the UI.
--
-- Mirror, not a second copy that can disagree: everything here is written from
-- a Stripe object, and there is no write policy for any CRM role.
-- ---------------------------------------------------------------------------
create table public.subscriptions (
  id                     uuid primary key default gen_random_uuid(),
  client_id              uuid references public.clients(id) on delete cascade,
  contract_id            uuid references public.contracts(id) on delete set null,

  stripe_subscription_id text not null unique,
  stripe_customer_id     text,
  stripe_price_id        text,
  status                 crm_subscription_status not null,

  -- Denormalised from the subscription's first item, so the pipeline value and
  -- the billing value can be compared without a Stripe round trip.
  amount                 numeric(12,2),
  currency               text not null default 'gbp',
  interval               text,
  interval_count         integer,
  quantity               integer,
  description            text,

  current_period_start   timestamptz,
  current_period_end     timestamptz,
  trial_end              timestamptz,
  cancel_at_period_end   boolean not null default false,
  canceled_at            timestamptz,
  ended_at               timestamptz,

  -- The `created` time of the most recent event applied to this row. An event
  -- older than this is a late delivery and is ignored.
  last_event_at          timestamptz,

  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create index subscriptions_client_id_idx on public.subscriptions (client_id);
create index subscriptions_contract_id_idx on public.subscriptions (contract_id);
create index subscriptions_status_idx    on public.subscriptions (status);
create index subscriptions_customer_idx  on public.subscriptions (stripe_customer_id);
-- The MRR query: everything currently billing.
create index subscriptions_live_idx on public.subscriptions (current_period_end)
  where status in ('active', 'trialing', 'past_due');

create trigger subscriptions_set_updated_at
  before update on public.subscriptions
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- payments gains everything an invoice needs.
--
-- The table already existed with the Stripe id columns and their unique
-- indexes; this is the invoice detail the dashboard and the client page show.
-- ---------------------------------------------------------------------------
alter table public.payments
  add column subscription_id     uuid references public.subscriptions(id) on delete set null,
  add column stripe_charge_id    text,
  -- Stripe's own status, stored verbatim. `status` is the CRM's reading of it;
  -- keeping the raw value means a mapping mistake is visible rather than lost,
  -- and a status Stripe adds later is still recorded.
  add column stripe_status       text,
  add column invoice_number      text,
  add column description         text,
  -- Where the client actually pays. Minted by Stripe, never constructed here.
  add column hosted_invoice_url  text,
  add column invoice_pdf_url     text,
  add column period_start        timestamptz,
  add column period_end          timestamptz,
  add column amount_due          numeric(12,2),
  add column amount_paid         numeric(12,2),
  add column amount_refunded     numeric(12,2) not null default 0,
  add column attempt_count       integer not null default 0,
  add column failure_reason      text,
  add column voided_at           timestamptz,
  add column last_event_at       timestamptz;

create index payments_subscription_id_idx on public.payments (subscription_id);
create index payments_paid_at_idx on public.payments (paid_at desc) where paid_at is not null;

-- ---------------------------------------------------------------------------
-- stripe_events: the idempotency ledger.
--
-- Stripe re-delivers on any non-2xx, and re-delivers on its own schedule
-- besides. Without this, a retried `invoice.paid` is harmless but a retried
-- `charge.refunded` would subtract twice.
--
-- No payload is stored. It would be the most sensitive data in the database -
-- full customer records, addresses, card metadata - kept for debugging value
-- that the Stripe dashboard already provides.
--
-- Service role only: RLS on, no policies.
-- ---------------------------------------------------------------------------
create table public.stripe_events (
  id            text primary key,          -- Stripe's evt_… id
  type          text not null,
  api_version   text,
  event_created timestamptz,
  received_at   timestamptz not null default now(),
  processed_at  timestamptz,
  status        text not null default 'received',  -- received | processed | ignored | failed
  error         text
);

create index stripe_events_type_idx     on public.stripe_events (type);
create index stripe_events_received_idx on public.stripe_events (received_at desc);
create index stripe_events_failed_idx   on public.stripe_events (received_at desc)
  where status = 'failed';

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
alter table public.subscriptions enable row level security;
alter table public.stripe_events enable row level security;

-- Read for any member. No INSERT, UPDATE or DELETE policy: the webhook owns
-- this table, exactly as it owns `payments`.
create policy subscriptions_select on public.subscriptions
  for select to authenticated using (public.crm_is_member());

-- stripe_events gets no policy at all.

comment on table public.subscriptions is
  'Mirror of Stripe subscriptions. Read-only to every CRM role; written only by the webhook as the service role.';
comment on table public.stripe_events is
  'Idempotency ledger for Stripe webhooks. Service role only; no payloads stored.';
comment on column public.payments.stripe_status is
  'Stripe''s own invoice status, verbatim. public.payments.status is the CRM reading of it.';
comment on column public.subscriptions.last_event_at is
  'created time of the last event applied. Older events are late deliveries and are ignored.';

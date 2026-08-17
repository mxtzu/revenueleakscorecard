-- Minimal stand-in for the parts of Supabase's `auth` schema that the CRM
-- migration depends on. Used only to apply and test migrations against a
-- local Postgres; Supabase provides the real versions.
create schema if not exists auth;

create table if not exists auth.users (
  id                  uuid primary key default gen_random_uuid(),
  email               text,
  raw_user_meta_data  jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now()
);

-- Supabase derives auth.uid() from the request JWT. Locally we read a GUC so
-- tests can impersonate a user with: set local request.jwt.claim.sub = '<uuid>'
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end;
$$;

-- Supabase grants these; the shim must match or RLS policies calling auth.uid()
-- fail with "permission denied for schema auth".
grant usage on schema auth to authenticated, anon, service_role;
grant execute on function auth.uid() to authenticated, anon, service_role;
grant usage on schema public to authenticated, anon, service_role;
alter default privileges in schema public
  grant select, insert, update, delete on tables to authenticated;
alter default privileges in schema public
  grant all on tables to service_role;

-- ---------------------------------------------------------------------------
-- Minimal stand-in for Supabase Storage, so 20260817_document_storage.sql runs
-- and its policies can be asserted locally instead of only in production.
-- ---------------------------------------------------------------------------
create schema if not exists storage;

create table if not exists storage.buckets (
  id               text primary key,
  name             text not null,
  public           boolean not null default false,
  file_size_limit  bigint,
  created_at       timestamptz not null default now()
);

create table if not exists storage.objects (
  id         uuid primary key default gen_random_uuid(),
  bucket_id  text references storage.buckets(id),
  name       text not null,
  owner      uuid,
  created_at timestamptz not null default now()
);

alter table storage.objects enable row level security;

grant usage on schema storage to authenticated, anon, service_role;

-- Storage for the `documents` table.
--
-- The table records metadata; the bytes live in a Supabase Storage bucket. The
-- bucket is PRIVATE: a public bucket would make every signed contract and
-- proposal readable by anyone who guessed a URL, and object paths are guessable
-- by construction (they contain the lead or client id).
--
-- Storage has its own RLS on `storage.objects`, entirely separate from the
-- table policies. Getting the row policy right and leaving the object policy
-- open is the classic way to leak files while the database looks locked down,
-- so the three policies below mirror the CRM's own rules exactly:
--
--   read    -> crm_is_member()    (same as every other CRM table)
--   write   -> crm_can_write()    (same as insert/update elsewhere)
--   delete  -> crm_is_admin()     (same as every other delete)
--
-- Safe to re-run.

do $$
begin
  -- Supabase provides the storage schema. A bare Postgres (the local test
  -- harness, a plain self-host) may not, and the CRM works without documents,
  -- so this degrades to a no-op rather than failing the whole migration.
  if not exists (select 1 from pg_namespace where nspname = 'storage') then
    raise notice 'storage schema absent; skipping document bucket setup';
    return;
  end if;

  insert into storage.buckets (id, name, public, file_size_limit)
  values ('crm-documents', 'crm-documents', false, 26214400)  -- 25 MiB
  on conflict (id) do update
    set public = false, file_size_limit = excluded.file_size_limit;

  if not exists (
    select 1 from pg_policies
     where schemaname = 'storage' and tablename = 'objects'
       and policyname = 'crm_documents_read'
  ) then
    execute $policy$
      create policy crm_documents_read on storage.objects
        for select to authenticated
        using (bucket_id = 'crm-documents' and public.crm_is_member())
    $policy$;
  end if;

  if not exists (
    select 1 from pg_policies
     where schemaname = 'storage' and tablename = 'objects'
       and policyname = 'crm_documents_write'
  ) then
    execute $policy$
      create policy crm_documents_write on storage.objects
        for insert to authenticated
        with check (bucket_id = 'crm-documents' and public.crm_can_write())
    $policy$;
  end if;

  if not exists (
    select 1 from pg_policies
     where schemaname = 'storage' and tablename = 'objects'
       and policyname = 'crm_documents_delete'
  ) then
    execute $policy$
      create policy crm_documents_delete on storage.objects
        for delete to authenticated
        using (bucket_id = 'crm-documents' and public.crm_is_admin())
    $policy$;
  end if;
end;
$$;

-- Finding a lead's or a client's files is the only way these are ever queried.
create index if not exists documents_crm_lead_id_idx
  on public.documents (crm_lead_id) where crm_lead_id is not null;
create index if not exists documents_client_id_idx
  on public.documents (client_id) where client_id is not null;

-- Proposals are always read per opportunity, newest version first.
create index if not exists proposals_opportunity_id_idx
  on public.proposals (opportunity_id);

-- Steps are always read as a whole sequence, in order.
create index if not exists outreach_steps_sequence_id_idx
  on public.outreach_steps (sequence_id, step_number);

comment on table public.documents is
  'File metadata. Bytes live in the private crm-documents storage bucket; '
  'storage_path is the object key within it.';

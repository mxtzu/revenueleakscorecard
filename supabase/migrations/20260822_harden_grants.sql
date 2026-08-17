-- ============================================================================
-- Sprint 7: closing an information leak found in the deployment security review.
--
-- `crm_is_suppressed(text, text)` is SECURITY DEFINER — it has to be, so the
-- send path can consult the do-not-contact list without granting anybody a
-- readable copy of it. What was missed is that Postgres grants EXECUTE on a new
-- function to PUBLIC by default, and PUBLIC includes `anon`.
--
-- The anon key is in the browser bundle by design, so anyone at all could ask:
--
--   select public.crm_is_suppressed('someone@somewhere.test', null);
--
-- and get a definitive yes or no. That leaks two things about a named person:
-- that this CRM holds a record of them, and that they unsubscribed, bounced or
-- complained. It is a small hole and an easy one to make — the function is not
-- referenced by any policy, so nothing failed to draw attention to it.
--
-- Fixed by revoking PUBLIC and granting only the callers that need it.
-- ============================================================================

revoke all on function public.crm_is_suppressed(text, text) from public;
grant execute on function public.crm_is_suppressed(text, text)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- The trigger functions, for the same reason.
--
-- Calling one directly fails with "can only be called as a trigger", so this is
-- tidiness rather than a hole being closed. Left executable by nobody but the
-- table owner, which is who actually invokes them.
--
-- `crm_role_of()` is deliberately NOT revoked from anon: every RLS policy on
-- every table calls it through `crm_is_member()`, and a signed-out request that
-- errored with "permission denied for function" instead of returning no rows
-- would be a worse answer than the one it gives today.
-- ---------------------------------------------------------------------------
do $$
declare
  fn text;
  triggers text[] := array[
    'public.halt_outreach_on_inbound_reply()',
    'public.handle_new_auth_user()',
    'public.queue_calendar_deletion()',
    'public.record_pipeline_stage_change()',
    'public.normalise_suppression()',
    'public.mark_appointment_dirty()',
    'public.set_updated_at()'
  ];
begin
  foreach fn in array triggers loop
    if to_regprocedure(fn) is not null then
      execute format('revoke all on function %s from public', fn);
    end if;
  end loop;
end;
$$;

comment on function public.crm_is_suppressed(text, text) is
  'Do-not-contact check for the send path. SECURITY DEFINER so it needs no read access to suppressions; NOT executable by anon, because a yes/no on an arbitrary address is an enumeration oracle.';

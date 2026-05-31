-- CodeRabbit caught a real money-trail weakness in 0022: the
-- payment_audit_staff_insert policy let any staff-role JWT fabricate
-- audit rows with arbitrary before/after payloads. Lock it down by
-- replacing the application-level INSERT path with a row-level trigger
-- on project_payments that writes the audit row server-side. After this:
--
--   - The RLS policy is GONE; nobody (not even staff) can INSERT into
--     payment_audit directly.
--   - Every actual project_payments mutation writes a payment_audit row
--     automatically, with actor_id = auth.uid() inside the trigger
--     context, and action computed from the operation + column changes
--     (deleted_at NULL → not-NULL = 'delete'; the reverse = 'restore').
--   - The action layer no longer needs to write audit rows at all.

drop policy if exists payment_audit_staff_insert on public.payment_audit;

-- Trigger function. SECURITY DEFINER so the insert succeeds with the
-- audit table's RLS still locked. The actor is captured from
-- auth.uid() at trigger time, which is the calling user's id from the
-- inbound JWT — *not* the function-definer's. So we get the real
-- mutator, not the function owner.

create or replace function public.record_payment_audit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_action text;
  v_actor uuid := auth.uid();
begin
  if tg_op = 'INSERT' then
    v_action := 'create';
    insert into public.payment_audit (payment_id, action, actor_id, before, after)
    values (new.id, v_action, v_actor, null, to_jsonb(new));
    return new;
  elsif tg_op = 'UPDATE' then
    -- Soft-delete transitions read as 'delete' or 'restore' so the audit
    -- trail tells a coherent story even though the table itself is
    -- update-only.
    if old.deleted_at is null and new.deleted_at is not null then
      v_action := 'delete';
    elsif old.deleted_at is not null and new.deleted_at is null then
      v_action := 'restore';
    else
      v_action := 'update';
    end if;
    insert into public.payment_audit (payment_id, action, actor_id, before, after)
    values (new.id, v_action, v_actor, to_jsonb(old), to_jsonb(new));
    return new;
  elsif tg_op = 'DELETE' then
    -- We don't normally hard-delete (savePayment uses soft-delete) but
    -- log it if someone does — e.g. an admin cleanup script.
    insert into public.payment_audit (payment_id, action, actor_id, before, after)
    values (old.id, 'delete', v_actor, to_jsonb(old), null);
    return old;
  end if;
  return null;
end;
$$;

-- Lock the function down. It's only ever invoked as a trigger so no
-- direct RPC callers should be able to abuse it.
revoke execute on function public.record_payment_audit() from public, anon, authenticated;

drop trigger if exists trg_record_payment_audit on public.project_payments;
create trigger trg_record_payment_audit
  after insert or update or delete on public.project_payments
  for each row execute function public.record_payment_audit();

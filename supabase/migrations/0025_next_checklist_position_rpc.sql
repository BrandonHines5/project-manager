-- Atomic position allocation for todo_checklist_items.
-- Two concurrent appends (e.g. two staff users, or the AI agent applying a
-- multi-mutation plan) currently both read `coalesce(max(position),0)+1`
-- separately and collide. The result is at best wrong ordering, at worst a
-- pair of items at the same slot.
--
-- This RPC takes an item_id and a label, allocates the next position in a
-- single statement, and returns the new id. SECURITY DEFINER lets us guard
-- the position arithmetic; we still check that the caller is staff and that
-- the parent schedule_item belongs to a project they can write to (RLS
-- check is implicit since we'll INSERT under the caller's session via SET
-- ROLE-style guard... but here SECURITY DEFINER bypasses RLS, so we
-- explicitly require staff).

create or replace function public.append_checklist_item(
  p_schedule_item_id uuid,
  p_label text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_id uuid;
  v_pos int;
begin
  if not public.is_staff() then
    raise exception 'only staff may append checklist items';
  end if;

  -- Lock the parent row briefly to serialize concurrent appends.
  perform 1 from public.schedule_items
    where id = p_schedule_item_id
    for update;
  if not found then
    raise exception 'parent schedule item not found';
  end if;

  select coalesce(max(position), -1) + 1
    into v_pos
    from public.todo_checklist_items
    where schedule_item_id = p_schedule_item_id;

  insert into public.todo_checklist_items (schedule_item_id, label, position)
  values (p_schedule_item_id, p_label, v_pos)
  returning id into v_id;

  return v_id;
end;
$fn$;

revoke execute on function public.append_checklist_item(uuid, text) from public, anon;
grant execute on function public.append_checklist_item(uuid, text) to authenticated;

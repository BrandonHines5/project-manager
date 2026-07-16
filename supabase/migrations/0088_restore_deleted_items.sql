-- Recently deleted → restore ("trash") for the main per-project entities.
--
-- The Project History feed (0073) records that something was deleted, but not
-- enough to bring it back. This migration adds `deleted_items`: on every
-- direct DELETE of a schedule item, decision, daily log, project file, bid
-- package or purchase order, a SECURITY DEFINER trigger snapshots the full
-- row PLUS its child rows (choices, line items, attachments, assignments,
-- checklists, comments, predecessor edges, nested to-dos…) into one jsonb
-- payload, so a server action can rebuild the whole thing with the same ids.
--
-- Project payments are deliberately excluded — they already soft-delete with
-- their own audit + restore (0022).
--
-- Conventions follow project_history (0073): project_id is a BARE uuid (no
-- FK) so project-delete cascades can't block on it; trigger-only writes (no
-- INSERT policy, EXECUTE revoked); staff-only read. Payloads can contain bid
-- tokens, so client/trade must never read this table.
--
-- Cascade deletes are skipped (pg_trigger_depth() > 1): a child row that dies
-- because its parent died is already inside the parent's snapshot, and a
-- project delete should leave no unreachable trash rows at all.
--
-- Retention: rows expire 30 days after deletion (purge_expired_deleted_items,
-- called lazily from the History page). The delete server actions no longer
-- remove attachment Storage objects up front — the purge does, and only for
-- entries that were never restored, so a restored item gets its files back.

create table if not exists public.deleted_items (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null,
  -- Same vocabulary as project_history.entity_type.
  entity_type text not null,
  entity_id uuid not null,
  entity_label text,
  -- { "row": {...}, "children": { "<table>": [...] }, "links": {...} }
  payload jsonb not null,
  -- Storage object keys owned by the snapshot; removed at purge time unless
  -- the entry was restored (the rows then reference these paths again).
  storage_paths text[] not null default '{}',
  deleted_by uuid references public.profiles(id) on delete set null,
  -- Snapshot so rows render after the profile is gone; null = system.
  deleted_by_name text,
  deleted_at timestamptz not null default now(),
  restored_at timestamptz,
  restored_by uuid references public.profiles(id) on delete set null
);

create index if not exists idx_di_project
  on public.deleted_items(project_id, deleted_at desc);
-- Covers "was this entity restored with its parent?" sibling claims.
create index if not exists idx_di_entity on public.deleted_items(entity_id);
-- Cover the profile FKs so team deletes don't seq-scan (linter INFO).
create index if not exists idx_di_deleted_by on public.deleted_items(deleted_by);
create index if not exists idx_di_restored_by on public.deleted_items(restored_by);

alter table public.deleted_items enable row level security;

drop policy if exists di_staff_read on public.deleted_items;
create policy di_staff_read on public.deleted_items
  for select using (public.is_staff());
-- No INSERT/UPDATE/DELETE policies on purpose: the trigger writes, the
-- SECURITY DEFINER helpers below claim/purge.

-- ---------------------------------------------------------------------------
-- Capture trigger
-- ---------------------------------------------------------------------------

create or replace function public.capture_deleted_item()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_project uuid;
  v_type text;
  v_label text;
  v_children jsonb := '{}'::jsonb;
  v_links jsonb := '{}'::jsonb;
  v_paths text[] := '{}';
  v_actor uuid := auth.uid();
  v_actor_name text;
  v_ids uuid[];
  v_tmp jsonb;
begin
  -- Depth 1 = a delete the user issued. Deeper = an FK cascade fired by some
  -- other row's delete; the parent snapshot already contains this row.
  if pg_trigger_depth() > 1 then
    return old;
  end if;

  if tg_table_name = 'schedule_items' then
    v_project := old.project_id;
    v_type := case when old.kind = 'work' then 'work_item' else 'todo' end;
    v_label := old.title;

    -- The whole subtree: nested to-dos cascade away with a work item, so
    -- they ride in this snapshot. (This trigger is named trg_a_* so it runs
    -- before trg_si_decision_due_unlink clears anchors — BEFORE triggers on
    -- the same event fire alphabetically.)
    with recursive subtree as (
      select s.id from public.schedule_items s where s.id = old.id
      union all
      select si.id from public.schedule_items si
        join subtree st on si.parent_id = st.id
    )
    select array_agg(id) into v_ids from subtree;

    select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at), '[]'::jsonb)
      into v_tmp from public.schedule_items t
      where t.id = any(v_ids) and t.id <> old.id;
    v_children := v_children || jsonb_build_object('schedule_items', v_tmp);

    select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) into v_tmp
      from public.schedule_assignments t where t.schedule_item_id = any(v_ids);
    v_children := v_children || jsonb_build_object('schedule_assignments', v_tmp);

    select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) into v_tmp
      from public.todo_checklist_items t where t.schedule_item_id = any(v_ids);
    v_children := v_children || jsonb_build_object('todo_checklist_items', v_tmp);

    select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) into v_tmp
      from public.schedule_item_attachments t where t.schedule_item_id = any(v_ids);
    v_children := v_children || jsonb_build_object('schedule_item_attachments', v_tmp);

    select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) into v_tmp
      from public.schedule_item_comments t where t.schedule_item_id = any(v_ids);
    v_children := v_children || jsonb_build_object('schedule_item_comments', v_tmp);

    select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) into v_tmp
      from public.schedule_delays t where t.schedule_item_id = any(v_ids);
    v_children := v_children || jsonb_build_object('schedule_delays', v_tmp);

    select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) into v_tmp
      from public.schedule_predecessors t
      where t.item_id = any(v_ids) or t.predecessor_id = any(v_ids);
    v_children := v_children || jsonb_build_object('schedule_predecessors', v_tmp);

    -- Anchor links get cleared by trg_si_decision_due_unlink in a moment;
    -- capture the triples so restore can re-link (best-effort).
    select coalesce(jsonb_agg(jsonb_build_object(
        'id', d.id,
        'schedule_item_id', d.due_anchor_schedule_item_id,
        'due_anchor', d.due_anchor,
        'due_anchor_offset_days', d.due_anchor_offset_days)), '[]'::jsonb)
      into v_tmp from public.decisions d
      where d.due_anchor_schedule_item_id = any(v_ids);
    v_links := v_links || jsonb_build_object('anchored_decisions', v_tmp);

    select coalesce(jsonb_agg(jsonb_build_object(
        'id', ft.id,
        'schedule_item_id', ft.anchor_schedule_item_id,
        'parent_anchor', ft.parent_anchor,
        'parent_offset_days', ft.parent_offset_days)), '[]'::jsonb)
      into v_tmp from public.decision_followup_templates ft
      where ft.anchor_schedule_item_id = any(v_ids);
    v_links := v_links || jsonb_build_object('anchored_followup_templates', v_tmp);

    -- Junction rows survive the item delete with schedule_item_id nulled;
    -- remember which ones pointed here so restore can re-point them.
    select coalesce(jsonb_agg(jsonb_build_object(
        'decision_id', m.decision_id,
        'template_id', m.template_id,
        'schedule_item_id', m.schedule_item_id)), '[]'::jsonb)
      into v_tmp from public.decision_followup_materializations m
      where m.schedule_item_id = any(v_ids);
    v_links := v_links || jsonb_build_object('materializations', v_tmp);

    select coalesce(array_agg(a.storage_path), '{}') into v_paths
      from public.schedule_item_attachments a where a.schedule_item_id = any(v_ids);

  elsif tg_table_name = 'decisions' then
    v_project := old.project_id;
    v_type := old.kind::text; -- 'change_order' | 'selection'
    v_label := '#' || old.number || ' ' || old.title;

    select coalesce(jsonb_agg(to_jsonb(t) order by t.position), '[]'::jsonb)
      into v_tmp from public.decision_choices t where t.decision_id = old.id;
    v_children := v_children || jsonb_build_object('decision_choices', v_tmp);

    select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) into v_tmp
      from public.decision_attachments t where t.decision_id = old.id;
    v_children := v_children || jsonb_build_object('decision_attachments', v_tmp);

    select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) into v_tmp
      from public.decision_cost_items t where t.decision_id = old.id;
    v_children := v_children || jsonb_build_object('decision_cost_items', v_tmp);

    select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) into v_tmp
      from public.decision_followup_templates t where t.decision_id = old.id;
    v_children := v_children || jsonb_build_object('decision_followup_templates', v_tmp);

    select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) into v_tmp
      from public.decision_comments t where t.decision_id = old.id;
    v_children := v_children || jsonb_build_object('decision_comments', v_tmp);

    select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) into v_tmp
      from public.decision_assignments t where t.decision_id = old.id;
    v_children := v_children || jsonb_build_object('decision_assignments', v_tmp);

    -- Restoring these keeps re-approval idempotent (no duplicate follow-ups).
    select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) into v_tmp
      from public.decision_followup_materializations t where t.decision_id = old.id;
    v_children := v_children || jsonb_build_object('decision_followup_materializations', v_tmp);

    -- Follow-up items survive with source_decision_id nulled (0004 SET NULL);
    -- remember them so restore can re-link.
    select coalesce(jsonb_agg(si.id), '[]'::jsonb) into v_tmp
      from public.schedule_items si where si.source_decision_id = old.id;
    v_links := v_links || jsonb_build_object('source_linked_items', v_tmp);

    select coalesce(array_agg(a.storage_path), '{}') into v_paths
      from public.decision_attachments a where a.decision_id = old.id;

  elsif tg_table_name = 'daily_logs' then
    v_project := old.project_id;
    v_type := 'daily_log';
    v_label := 'Log ' || old.log_date;

    select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) into v_tmp
      from public.daily_log_subs_on_site t where t.daily_log_id = old.id;
    v_children := v_children || jsonb_build_object('daily_log_subs_on_site', v_tmp);

    select coalesce(jsonb_agg(to_jsonb(t) order by t.position), '[]'::jsonb)
      into v_tmp from public.daily_log_attachments t where t.daily_log_id = old.id;
    v_children := v_children || jsonb_build_object('daily_log_attachments', v_tmp);

    select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) into v_tmp
      from public.daily_log_comments t where t.daily_log_id = old.id;
    v_children := v_children || jsonb_build_object('daily_log_comments', v_tmp);

    select coalesce(array_agg(a.storage_path), '{}') into v_paths
      from public.daily_log_attachments a where a.daily_log_id = old.id;

  elsif tg_table_name = 'project_files' then
    v_project := old.project_id;
    v_type := 'file';
    v_label := old.title;
    v_paths := array[old.storage_path];

  elsif tg_table_name = 'bid_packages' then
    v_project := old.project_id;
    v_type := 'bid_package';
    v_label := '#' || old.number || ' ' || old.title;

    select coalesce(jsonb_agg(to_jsonb(t) order by t.position), '[]'::jsonb)
      into v_tmp from public.bid_package_line_items t where t.bid_package_id = old.id;
    v_children := v_children || jsonb_build_object('bid_package_line_items', v_tmp);

    select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) into v_tmp
      from public.bid_package_attachments t where t.bid_package_id = old.id;
    v_children := v_children || jsonb_build_object('bid_package_attachments', v_tmp);

    select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) into v_tmp
      from public.bid_recipients t where t.bid_package_id = old.id;
    v_children := v_children || jsonb_build_object('bid_recipients', v_tmp);

    select coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb) into v_tmp
      from public.bid_line_item_quotes q
      join public.bid_recipients r on r.id = q.bid_recipient_id
      where r.bid_package_id = old.id;
    v_children := v_children || jsonb_build_object('bid_line_item_quotes', v_tmp);

    select coalesce(jsonb_agg(to_jsonb(c)), '[]'::jsonb) into v_tmp
      from public.bid_comments c
      join public.bid_recipients r on r.id = c.bid_recipient_id
      where r.bid_package_id = old.id;
    v_children := v_children || jsonb_build_object('bid_comments', v_tmp);

    select coalesce(array_agg(a.storage_path), '{}') into v_paths
      from public.bid_package_attachments a where a.bid_package_id = old.id;

  elsif tg_table_name = 'purchase_orders' then
    v_project := old.project_id;
    v_type := 'purchase_order';
    v_label := '#' || old.number || ' ' || old.title;

    select coalesce(jsonb_agg(to_jsonb(t) order by t.position), '[]'::jsonb)
      into v_tmp from public.po_line_items t where t.purchase_order_id = old.id;
    v_children := v_children || jsonb_build_object('po_line_items', v_tmp);

    select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) into v_tmp
      from public.po_attachments t where t.purchase_order_id = old.id;
    v_children := v_children || jsonb_build_object('po_attachments', v_tmp);

    select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) into v_tmp
      from public.po_comments t where t.purchase_order_id = old.id;
    v_children := v_children || jsonb_build_object('po_comments', v_tmp);

    select coalesce(array_agg(a.storage_path), '{}') into v_paths
      from public.po_attachments a where a.purchase_order_id = old.id;

  else
    return old;
  end if;

  if v_actor is not null then
    select full_name into v_actor_name from public.profiles where id = v_actor;
  end if;

  insert into public.deleted_items
    (project_id, entity_type, entity_id, entity_label, payload, storage_paths,
     deleted_by, deleted_by_name)
  values (
    v_project,
    v_type,
    old.id,
    left(coalesce(v_label, ''), 200),
    jsonb_build_object('row', to_jsonb(old), 'children', v_children, 'links', v_links),
    coalesce(v_paths, '{}'),
    v_actor,
    v_actor_name
  );
  return old;
end;
$fn$;

revoke execute on function public.capture_deleted_item() from public, anon, authenticated;

-- BEFORE DELETE so child rows still exist when we snapshot (FK cascades run
-- during the parent row's deletion). trg_a_* sorts before the other BEFORE
-- DELETE triggers on schedule_items (trg_si_decision_due_unlink,
-- trg_si_protect_milestones), so anchors are captured pre-unlink and an
-- aborted milestone delete rolls this insert back with it.
do $$
declare
  t text;
begin
  foreach t in array array[
    'schedule_items', 'decisions', 'daily_logs', 'project_files',
    'bid_packages', 'purchase_orders'
  ]
  loop
    execute format('drop trigger if exists trg_a_trash_%s on public.%I', t, t);
    execute format(
      'create trigger trg_a_trash_%s before delete on public.%I
         for each row execute function public.capture_deleted_item()',
      t, t
    );
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Restore / purge helpers (SECURITY DEFINER; staff-gated inside)
-- ---------------------------------------------------------------------------

-- Atomically claim a trash entry for restore. Returns the claimed row, or no
-- rows when it's already restored / missing — the double-click and the
-- concurrent-restore both land on "already restored" instead of duplicating.
create or replace function public.claim_deleted_item(p_id uuid)
returns setof public.deleted_items
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if not public.is_staff() then
    raise exception 'staff only';
  end if;
  return query
    update public.deleted_items
       set restored_at = now(), restored_by = auth.uid()
     where id = p_id and restored_at is null
    returning *;
end;
$fn$;

-- Release a claim after a failed restore so the entry stays restorable.
create or replace function public.unclaim_deleted_item(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if not public.is_staff() then
    raise exception 'staff only';
  end if;
  update public.deleted_items
     set restored_at = null, restored_by = null
   where id = p_id;
end;
$fn$;

-- After a successful restore, mark any OTHER unrestored entries for the same
-- entities as restored too. A bulk delete of a work item plus its child
-- to-dos writes overlapping snapshots (the child rides in the parent's
-- subtree AND gets its own entry); once the parent restore brings the child
-- back, the child's own entry must not linger — its expiry purge would
-- delete Storage objects the restored rows reference again.
create or replace function public.claim_restored_entities(
  p_project uuid, p_entity_ids uuid[]
)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if not public.is_staff() then
    raise exception 'staff only';
  end if;
  update public.deleted_items
     set restored_at = now(), restored_by = auth.uid()
   where project_id = p_project
     and entity_id = any(p_entity_ids)
     and restored_at is null;
end;
$fn$;

-- Drop entries past the 30-day retention for one project, returning the
-- Storage paths of entries that were NEVER restored so the caller can remove
-- the objects. Restored entries keep their objects — the live rows reference
-- those paths again. Called lazily when the History page loads.
create or replace function public.purge_expired_deleted_items(p_project uuid)
returns table (storage_paths text[], was_restored boolean)
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if not public.is_staff() then
    raise exception 'staff only';
  end if;
  return query
    delete from public.deleted_items d
     where d.project_id = p_project
       and d.deleted_at < now() - interval '30 days'
    returning d.storage_paths, (d.restored_at is not null);
end;
$fn$;

revoke execute on function public.claim_deleted_item(uuid) from public, anon;
revoke execute on function public.unclaim_deleted_item(uuid) from public, anon;
revoke execute on function public.claim_restored_entities(uuid, uuid[]) from public, anon;
revoke execute on function public.purge_expired_deleted_items(uuid) from public, anon;
grant execute on function public.claim_deleted_item(uuid) to authenticated;
grant execute on function public.unclaim_deleted_item(uuid) to authenticated;
grant execute on function public.claim_restored_entities(uuid, uuid[]) to authenticated;
grant execute on function public.purge_expired_deleted_items(uuid) to authenticated;

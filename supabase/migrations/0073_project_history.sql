-- Project History: a per-project audit feed backing the "History" tab.
--
-- One generic SECURITY DEFINER row trigger (record_project_history) writes an
-- event per INSERT/UPDATE/DELETE on the main per-project tables. Follows the
-- payment_audit conventions from 0031: trigger-only writes (no INSERT policy),
-- EXECUTE revoked, staff-only read.
--
-- project_id is deliberately a BARE uuid (no FK): during a project-delete
-- cascade child-table triggers still fire, and an FK here would either block
-- the delete or race the cascade. Orphaned history rows for deleted projects
-- are unreachable from the UI and harmless.

create table if not exists public.project_history (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null,
  entity_type text not null,
  entity_id uuid,
  entity_label text,
  action text not null check (action in ('create', 'update', 'delete')),
  actor_id uuid references public.profiles(id) on delete set null,
  -- Snapshot so rows render after the profile is gone; null = system/automation.
  actor_name text,
  -- Per-field diff for updates: { "<column>": { "from": ..., "to": ... } }.
  changes jsonb,
  -- Groups rows written by one statement/transaction (bulk shifts, cascades,
  -- duplicate-project) so the UI can collapse them into a single event.
  txid bigint not null default txid_current(),
  created_at timestamptz not null default now()
);

create index if not exists idx_ph_project on public.project_history(project_id, created_at desc);
create index if not exists idx_ph_actor on public.project_history(actor_id);

alter table public.project_history enable row level security;

drop policy if exists ph_staff_read on public.project_history;
create policy ph_staff_read on public.project_history
  for select using (public.is_staff());
-- No INSERT/UPDATE/DELETE policies on purpose: only the trigger writes.

create or replace function public.record_project_history()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_new jsonb := case when tg_op = 'DELETE' then null else to_jsonb(new) end;
  v_old jsonb := case when tg_op = 'INSERT' then null else to_jsonb(old) end;
  v_row jsonb := coalesce(v_new, v_old);
  v_project uuid;
  v_type text;
  v_label text;
  v_entity uuid;
  v_changes jsonb;
  v_actor uuid := auth.uid();
  v_actor_name text;
  v_assignee text;
begin
  -- Resolve project, entity type and a display label per table.
  if tg_table_name = 'schedule_items' then
    v_project := (v_row->>'project_id')::uuid;
    v_type := case when v_row->>'kind' = 'work' then 'work_item' else 'todo' end;
    v_label := v_row->>'title';
  elsif tg_table_name = 'decisions' then
    v_project := (v_row->>'project_id')::uuid;
    v_type := v_row->>'kind'; -- 'change_order' | 'selection'
    v_label := '#' || (v_row->>'number') || ' ' || (v_row->>'title');
  elsif tg_table_name = 'daily_logs' then
    v_project := (v_row->>'project_id')::uuid;
    v_type := 'daily_log';
    v_label := 'Log ' || (v_row->>'log_date');
  elsif tg_table_name = 'project_files' then
    v_project := (v_row->>'project_id')::uuid;
    v_type := 'file';
    v_label := v_row->>'title';
  elsif tg_table_name = 'project_payments' then
    v_project := (v_row->>'project_id')::uuid;
    v_type := 'payment';
    v_label := '$' || (v_row->>'amount') || ' on ' || (v_row->>'paid_on');
  elsif tg_table_name = 'bid_packages' then
    v_project := (v_row->>'project_id')::uuid;
    v_type := 'bid_package';
    v_label := '#' || (v_row->>'number') || ' ' || (v_row->>'title');
  elsif tg_table_name = 'purchase_orders' then
    v_project := (v_row->>'project_id')::uuid;
    v_type := 'purchase_order';
    v_label := '#' || (v_row->>'number') || ' ' || (v_row->>'title');
  elsif tg_table_name = 'project_members' then
    v_project := (v_row->>'project_id')::uuid;
    v_type := 'member';
    select full_name into v_label from public.profiles
      where id = (v_row->>'profile_id')::uuid;
    v_label := coalesce(v_label, 'Member');
  elsif tg_table_name = 'project_role_members' then
    v_project := (v_row->>'project_id')::uuid;
    v_type := 'role_assignment';
    select name into v_label from public.roles
      where id = (v_row->>'role_id')::uuid;
    if v_row->>'profile_id' is not null then
      select full_name into v_assignee from public.profiles
        where id = (v_row->>'profile_id')::uuid;
    elsif v_row->>'company_id' is not null then
      select name into v_assignee from public.companies
        where id = (v_row->>'company_id')::uuid;
    end if;
    v_label := coalesce(v_label, 'Role')
      || case when v_assignee is not null then ' → ' || v_assignee else '' end;
  elsif tg_table_name = 'schedule_assignments' then
    -- Resolve project through the parent item. During a schedule-item delete
    -- cascade the parent row may already be gone — skip those (the item's own
    -- delete event covers it).
    select project_id, title into v_project, v_label
      from public.schedule_items
      where id = (v_row->>'schedule_item_id')::uuid;
    if v_project is null then
      return null;
    end if;
    v_type := 'assignment';
    if v_row->>'profile_id' is not null then
      select full_name into v_assignee from public.profiles
        where id = (v_row->>'profile_id')::uuid;
    elsif v_row->>'company_id' is not null then
      select name into v_assignee from public.companies
        where id = (v_row->>'company_id')::uuid;
    elsif v_row->>'role_id' is not null then
      select name into v_assignee from public.roles
        where id = (v_row->>'role_id')::uuid;
    end if;
    v_label := coalesce(v_label, 'Item')
      || case when v_assignee is not null then ' → ' || v_assignee else '' end;
  elsif tg_table_name = 'projects' then
    v_project := (v_row->>'id')::uuid;
    v_type := 'project';
    v_label := v_row->>'name';
  else
    return null;
  end if;

  -- Per-field diff for updates; skip pure-noise updates (touch triggers).
  if tg_op = 'UPDATE' then
    select jsonb_object_agg(n.key, jsonb_build_object('from', o.value, 'to', n.value))
      into v_changes
      from jsonb_each(v_old) o
      join jsonb_each(v_new) n on n.key = o.key
      where o.value is distinct from n.value
        and n.key not in ('updated_at', 'created_at');
    if v_changes is null then
      return null;
    end if;
  end if;

  if v_actor is not null then
    select full_name into v_actor_name from public.profiles where id = v_actor;
  end if;

  insert into public.project_history
    (project_id, entity_type, entity_id, entity_label, action, actor_id, actor_name, changes)
  values (
    v_project,
    v_type,
    (v_row->>'id')::uuid, -- null for composite-PK tables (project_members, project_role_members)
    left(coalesce(v_label, ''), 200),
    case tg_op when 'INSERT' then 'create' when 'UPDATE' then 'update' else 'delete' end,
    v_actor,
    v_actor_name,
    v_changes
  );
  return null;
end;
$fn$;

revoke execute on function public.record_project_history() from public, anon, authenticated;

-- Attach to the main per-project tables.
do $$
declare
  t text;
begin
  foreach t in array array[
    'schedule_items', 'decisions', 'daily_logs', 'project_files',
    'project_payments', 'bid_packages', 'purchase_orders',
    'project_members', 'project_role_members', 'schedule_assignments'
  ]
  loop
    execute format('drop trigger if exists trg_hist_%s on public.%I', t, t);
    execute format(
      'create trigger trg_hist_%s after insert or update or delete on public.%I
         for each row execute function public.record_project_history()',
      t, t
    );
  end loop;
end $$;

-- projects: updates only (creation is implicit; deletion removes the feed).
drop trigger if exists trg_hist_projects on public.projects;
create trigger trg_hist_projects after update on public.projects
  for each row execute function public.record_project_history();

-- =====================================================================
-- HH Project Manager - Initial schema
-- Foundation + Schedule/To-Dos module
-- =====================================================================

-- Extensions
create extension if not exists "pgcrypto";

-- =====================================================================
-- Enums
-- =====================================================================
do $$ begin
  create type user_role as enum ('staff', 'trade', 'client');
exception when duplicate_object then null; end $$;

do $$ begin
  create type company_type as enum ('sub', 'vendor', 'client');
exception when duplicate_object then null; end $$;

do $$ begin
  create type project_status as enum ('lead', 'pre_construction', 'active', 'on_hold', 'complete', 'cancelled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type schedule_item_kind as enum ('work', 'todo');
exception when duplicate_object then null; end $$;

do $$ begin
  create type schedule_item_status as enum ('not_started', 'in_progress', 'complete', 'delayed');
exception when duplicate_object then null; end $$;

do $$ begin
  create type dependency_type as enum ('FS', 'SS', 'FF', 'SF');
exception when duplicate_object then null; end $$;

do $$ begin
  create type delay_reason as enum ('weather', 'sub', 'material', 'owner_decision', 'permit', 'other');
exception when duplicate_object then null; end $$;

-- =====================================================================
-- companies (subs / vendors / client households)
-- =====================================================================
create table if not exists public.companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  type company_type not null,
  trade_category text,
  address text,
  phone text,
  email text,
  notes text,
  created_at timestamptz not null default now()
);
create index if not exists idx_companies_type on public.companies(type);

-- =====================================================================
-- profiles (1:1 with auth.users)
-- =====================================================================
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null default '',
  email text not null,
  role user_role not null default 'staff',
  company_id uuid references public.companies(id) on delete set null,
  phone text,
  created_at timestamptz not null default now()
);
create index if not exists idx_profiles_role on public.profiles(role);
create index if not exists idx_profiles_company on public.profiles(company_id);

-- Trigger: create profile row on new auth user
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name, role)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', ''),
    coalesce((new.raw_user_meta_data->>'role')::user_role, 'staff')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- =====================================================================
-- projects
-- =====================================================================
create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  project_number text not null unique,
  name text not null,
  address text,
  client_company_id uuid references public.companies(id) on delete set null,
  status project_status not null default 'active',
  contract_price numeric(14,2),
  start_date date,
  target_completion_date date,
  dashboard_url text,
  notes text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists idx_projects_status on public.projects(status);
create index if not exists idx_projects_client on public.projects(client_company_id);

-- =====================================================================
-- project_members (who can see what project)
-- =====================================================================
create table if not exists public.project_members (
  project_id uuid not null references public.projects(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  role_on_project text,
  created_at timestamptz not null default now(),
  primary key (project_id, profile_id)
);
create index if not exists idx_pm_profile on public.project_members(profile_id);

-- =====================================================================
-- schedule_items (single table: 'work' bars and 'todo' children)
-- =====================================================================
create table if not exists public.schedule_items (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  parent_id uuid references public.schedule_items(id) on delete cascade,
  kind schedule_item_kind not null,
  title text not null,
  description text,
  start_date date,
  end_date date,
  due_date date,
  duration_days int,
  status schedule_item_status not null default 'not_started',
  baseline_start_date date,
  baseline_end_date date,
  recurrence_rule jsonb,
  recurrence_parent_id uuid references public.schedule_items(id) on delete cascade,
  position int not null default 0,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- A work item uses start/end; a todo uses due_date. We don't strictly enforce, but indexes help.
  constraint schedule_items_dates_chk
    check ( (start_date is null and end_date is null) or (start_date is not null and end_date is not null and end_date >= start_date) )
);
create index if not exists idx_si_project on public.schedule_items(project_id);
create index if not exists idx_si_parent on public.schedule_items(parent_id);
create index if not exists idx_si_kind on public.schedule_items(kind);
create index if not exists idx_si_dates on public.schedule_items(start_date, end_date);
create index if not exists idx_si_due on public.schedule_items(due_date);
create index if not exists idx_si_recurrence_parent on public.schedule_items(recurrence_parent_id);

-- updated_at trigger
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_si_updated_at on public.schedule_items;
create trigger trg_si_updated_at before update on public.schedule_items
  for each row execute function public.touch_updated_at();

-- =====================================================================
-- schedule_predecessors
-- =====================================================================
create table if not exists public.schedule_predecessors (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.schedule_items(id) on delete cascade,
  predecessor_id uuid not null references public.schedule_items(id) on delete cascade,
  dep_type dependency_type not null default 'FS',
  lag_days int not null default 0,
  created_at timestamptz not null default now(),
  unique(item_id, predecessor_id),
  check (item_id <> predecessor_id)
);
create index if not exists idx_sp_item on public.schedule_predecessors(item_id);
create index if not exists idx_sp_pred on public.schedule_predecessors(predecessor_id);

-- =====================================================================
-- schedule_assignments
-- =====================================================================
create table if not exists public.schedule_assignments (
  id uuid primary key default gen_random_uuid(),
  schedule_item_id uuid not null references public.schedule_items(id) on delete cascade,
  profile_id uuid references public.profiles(id) on delete cascade,
  company_id uuid references public.companies(id) on delete cascade,
  notified_at timestamptz,
  created_at timestamptz not null default now(),
  check (profile_id is not null or company_id is not null),
  unique nulls not distinct (schedule_item_id, profile_id, company_id)
);
create index if not exists idx_sa_item on public.schedule_assignments(schedule_item_id);
create index if not exists idx_sa_profile on public.schedule_assignments(profile_id);
create index if not exists idx_sa_company on public.schedule_assignments(company_id);

-- =====================================================================
-- todo_checklist_items
-- =====================================================================
create table if not exists public.todo_checklist_items (
  id uuid primary key default gen_random_uuid(),
  schedule_item_id uuid not null references public.schedule_items(id) on delete cascade,
  label text not null,
  is_done boolean not null default false,
  position int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists idx_tci_item on public.todo_checklist_items(schedule_item_id);

-- =====================================================================
-- schedule_delays
-- =====================================================================
create table if not exists public.schedule_delays (
  id uuid primary key default gen_random_uuid(),
  schedule_item_id uuid not null references public.schedule_items(id) on delete cascade,
  delay_days int not null,
  reason_category delay_reason not null,
  notes text,
  logged_by uuid references public.profiles(id) on delete set null,
  logged_at timestamptz not null default now()
);
create index if not exists idx_sd_item on public.schedule_delays(schedule_item_id);
create index if not exists idx_sd_reason on public.schedule_delays(reason_category);

-- =====================================================================
-- notifications (in-app bell)
-- =====================================================================
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references public.profiles(id) on delete cascade,
  type text not null,
  title text not null,
  body text,
  link_url text,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_notif_recipient on public.notifications(recipient_id, read_at);

-- =====================================================================
-- Helper: SECURITY DEFINER role lookup
-- Avoids RLS recursion when checking own role.
-- =====================================================================
create or replace function public.current_role_name()
returns user_role
language sql
stable
security definer
set search_path = public
as $$
  select role from public.profiles where id = auth.uid();
$$;

create or replace function public.is_staff()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select role from public.profiles where id = auth.uid()) = 'staff', false);
$$;

create or replace function public.is_member_of_project(p_project uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.project_members
    where project_id = p_project and profile_id = auth.uid()
  );
$$;

-- =====================================================================
-- Row Level Security
-- =====================================================================
alter table public.companies            enable row level security;
alter table public.profiles             enable row level security;
alter table public.projects             enable row level security;
alter table public.project_members      enable row level security;
alter table public.schedule_items       enable row level security;
alter table public.schedule_predecessors enable row level security;
alter table public.schedule_assignments enable row level security;
alter table public.todo_checklist_items enable row level security;
alter table public.schedule_delays      enable row level security;
alter table public.notifications        enable row level security;

-- ----- profiles -----
drop policy if exists profiles_self_read on public.profiles;
create policy profiles_self_read on public.profiles
  for select using (id = auth.uid() or public.is_staff());

drop policy if exists profiles_staff_all on public.profiles;
create policy profiles_staff_all on public.profiles
  for all using (public.is_staff()) with check (public.is_staff());

drop policy if exists profiles_self_update on public.profiles;
create policy profiles_self_update on public.profiles
  for update using (id = auth.uid()) with check (id = auth.uid());

-- ----- companies (staff full; trade/client read own) -----
drop policy if exists companies_staff_all on public.companies;
create policy companies_staff_all on public.companies
  for all using (public.is_staff()) with check (public.is_staff());

drop policy if exists companies_self_read on public.companies;
create policy companies_self_read on public.companies
  for select using (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.company_id = companies.id)
  );

-- ----- projects -----
drop policy if exists projects_staff_all on public.projects;
create policy projects_staff_all on public.projects
  for all using (public.is_staff()) with check (public.is_staff());

drop policy if exists projects_member_read on public.projects;
create policy projects_member_read on public.projects
  for select using (public.is_member_of_project(id));

-- ----- project_members -----
drop policy if exists project_members_staff_all on public.project_members;
create policy project_members_staff_all on public.project_members
  for all using (public.is_staff()) with check (public.is_staff());

drop policy if exists project_members_self_read on public.project_members;
create policy project_members_self_read on public.project_members
  for select using (profile_id = auth.uid());

-- ----- schedule_items -----
-- staff: all. trade: only items they're assigned to (and a few client never).
drop policy if exists schedule_items_staff_all on public.schedule_items;
create policy schedule_items_staff_all on public.schedule_items
  for all using (public.is_staff()) with check (public.is_staff());

drop policy if exists schedule_items_trade_read on public.schedule_items;
create policy schedule_items_trade_read on public.schedule_items
  for select using (
    public.current_role_name() = 'trade'
    and exists (
      select 1 from public.schedule_assignments sa
      left join public.profiles p on p.id = auth.uid()
      where sa.schedule_item_id = schedule_items.id
        and (sa.profile_id = auth.uid() or sa.company_id = p.company_id)
    )
  );

-- ----- schedule_predecessors / assignments / checklist / delays -----
-- Inherit access from schedule_items via EXISTS check.
do $$
declare t text;
begin
  for t in select unnest(array['schedule_predecessors','schedule_assignments','todo_checklist_items','schedule_delays']) loop
    execute format($f$
      drop policy if exists %1$s_staff_all on public.%1$s;
      create policy %1$s_staff_all on public.%1$s
        for all using (public.is_staff()) with check (public.is_staff());
    $f$, t);
  end loop;
end $$;

drop policy if exists schedule_assignments_self_read on public.schedule_assignments;
create policy schedule_assignments_self_read on public.schedule_assignments
  for select using (
    profile_id = auth.uid()
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.company_id = schedule_assignments.company_id)
  );

-- ----- notifications -----
drop policy if exists notifications_self_all on public.notifications;
create policy notifications_self_all on public.notifications
  for all using (recipient_id = auth.uid()) with check (recipient_id = auth.uid());

drop policy if exists notifications_staff_insert on public.notifications;
create policy notifications_staff_insert on public.notifications
  for insert with check (public.is_staff());

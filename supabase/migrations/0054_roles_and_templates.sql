-- =====================================================================
-- 0054 — Project templates + role-based assignments
-- =====================================================================
-- Two related capabilities, both in service of "build a job from a
-- standard template, then fill in who does what per job":
--
--  1. projects.is_template — marks a project as a reusable template. The
--     "New project → Start from template" picker now offers ONLY templates
--     instead of every project in the system.
--
--  2. Roles — a small org-wide catalog (`roles`) of jobs-to-be-filled
--     ("Project Manager", "Footings Excavator", …). A template's schedule
--     items are assigned to a ROLE instead of a specific person. Each real
--     project then maps every role to a concrete profile or company in its
--     Roles tab (`project_role_members`). A schedule item assigned to a role
--     resolves through that per-project map for display ("Footings Excavator
--     (Kauai Excavation)") and for trade visibility — change the map and
--     every item assigned to that role follows, with no per-item edits.
--
-- All additive: new columns are nullable / defaulted, new tables get their
-- own RLS, and the one relaxed CHECK only widens what's allowed.

-- ---------------------------------------------------------------------
-- 1. Templates
-- ---------------------------------------------------------------------
alter table public.projects
  add column if not exists is_template boolean not null default false;

-- Partial index: the only query is "list the templates", a small subset.
create index if not exists idx_projects_is_template
  on public.projects(is_template) where is_template;

comment on column public.projects.is_template is
  'When true this project is a reusable template — the only kind of project '
  'offered as a source in the "New project → Start from template" picker.';

-- ---------------------------------------------------------------------
-- 2. Role catalog (org-wide)
-- ---------------------------------------------------------------------
create table if not exists public.roles (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) between 1 and 80),
  -- Which kind of CRM record usually fills this role. Drives the per-project
  -- picker's default list ('staff' → profiles, 'company' → subs/vendors,
  -- 'any' → both). Advisory only — the member row isn't constrained by it,
  -- so a builder can always override.
  kind text not null default 'any' check (kind in ('staff', 'company', 'any')),
  -- Manual ordering for the Roles tab; ties break on name.
  position int not null default 0,
  created_at timestamptz not null default now()
);

-- Case-insensitive uniqueness so "Project Manager" / "project manager" can't
-- both exist.
create unique index if not exists uq_roles_name_lower
  on public.roles (lower(trim(name)));

comment on table public.roles is
  'Org-wide catalog of assignable roles (e.g. "Project Manager", "Footings '
  'Excavator"). Schedule items can be assigned to a role; each project maps '
  'the role to a person/company in project_role_members.';

-- Seed a couple of obvious staff roles so the feature is usable immediately.
-- Trade-specific roles ("Framer", "Footings Excavator", …) are builder-
-- specific and added from the UI. Guarded so replaying the migration is safe.
insert into public.roles (name, kind, position)
select v.name, v.kind, v.position
from (values
  ('Project Manager', 'staff', 0),
  ('Site Superintendent', 'staff', 1)
) as v(name, kind, position)
where not exists (
  select 1 from public.roles r where lower(trim(r.name)) = lower(trim(v.name))
);

-- ---------------------------------------------------------------------
-- 3. Per-project role → assignee map
-- ---------------------------------------------------------------------
create table if not exists public.project_role_members (
  project_id uuid not null references public.projects(id) on delete cascade,
  role_id uuid not null references public.roles(id) on delete cascade,
  -- ON DELETE CASCADE (not SET NULL): when the assignee profile/company is
  -- deleted the mapping row goes away and the role is simply unfilled. SET
  -- NULL would zero out the only non-null column and trip the one-assignee
  -- CHECK below, which would abort the profile/company delete entirely.
  profile_id uuid references public.profiles(id) on delete cascade,
  company_id uuid references public.companies(id) on delete cascade,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null,
  primary key (project_id, role_id),
  -- Exactly one assignee kind. An unfilled role simply has no row.
  constraint project_role_members_one_assignee
    check (num_nonnulls(profile_id, company_id) = 1)
);
create index if not exists idx_prm_role on public.project_role_members(role_id);
create index if not exists idx_prm_profile on public.project_role_members(profile_id);
create index if not exists idx_prm_company on public.project_role_members(company_id);

drop trigger if exists trg_prm_updated_at on public.project_role_members;
create trigger trg_prm_updated_at before update on public.project_role_members
  for each row execute function public.touch_updated_at();

comment on table public.project_role_members is
  'Per-project assignment of a catalog role to a concrete profile or company. '
  'Resolves role-based schedule assignments to a real person for this job.';

-- ---------------------------------------------------------------------
-- 4. role_id on schedule_assignments
-- ---------------------------------------------------------------------
alter table public.schedule_assignments
  add column if not exists role_id uuid references public.roles(id) on delete cascade;
create index if not exists idx_sa_role on public.schedule_assignments(role_id);

-- Widen the assignee XOR from (profile | company) to exactly-one-of
-- (profile | company | role). The original inline CHECK is named
-- schedule_assignments_check (verified against the live schema).
alter table public.schedule_assignments
  drop constraint if exists schedule_assignments_check;
alter table public.schedule_assignments
  add constraint schedule_assignments_one_assignee
  check (num_nonnulls(profile_id, company_id, role_id) = 1);

-- Re-key uniqueness to include role_id so a role can't be double-added and the
-- duplicate de-dupe still works. Replaces the original 3-column unique.
alter table public.schedule_assignments
  drop constraint if exists schedule_assignments_schedule_item_id_profile_id_company_id_key;
create unique index if not exists uq_schedule_assignments_target
  on public.schedule_assignments (schedule_item_id, profile_id, company_id, role_id)
  nulls not distinct;

-- ---------------------------------------------------------------------
-- 5. RLS
-- ---------------------------------------------------------------------
alter table public.roles                 enable row level security;
alter table public.project_role_members  enable row level security;

-- Roles are plain labels — every signed-in user can read them (needed to
-- resolve "Role (Person)" everywhere); only staff manage the catalog. Scoped
-- to `authenticated` so the anon API role can't read the catalog.
drop policy if exists roles_read_all on public.roles;
create policy roles_read_all on public.roles
  for select to authenticated using (true);
drop policy if exists roles_staff_all on public.roles;
create policy roles_staff_all on public.roles
  for all using (public.is_staff()) with check (public.is_staff());

-- Project role map: staff manage; only the assigned trade (profile or company)
-- reads their own membership row, so the schedule resolves role names for them.
-- Clients are deliberately NOT granted read here — they have no Roles/Schedule
-- UI and shouldn't see the internal role→assignee map for their job.
drop policy if exists prm_staff_all on public.project_role_members;
create policy prm_staff_all on public.project_role_members
  for all using (public.is_staff()) with check (public.is_staff());
-- auth.uid() is wrapped in a scalar subquery so the planner evaluates it once
-- per query (initplan) instead of once per row.
drop policy if exists prm_member_read on public.project_role_members;
create policy prm_member_read on public.project_role_members
  for select using (
    profile_id = (select auth.uid())
    or exists (
      select 1 from public.profiles p
      where p.id = (select auth.uid())
        and p.company_id = project_role_members.company_id
    )
  );

-- A trade should see a schedule item assigned to a role that resolves (via
-- this project's role map) to them or their company. SECURITY DEFINER to
-- sidestep RLS-in-policy recursion, mirroring is_member_of_project.
create or replace function public.trade_sees_item_via_role(p_item uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.schedule_assignments sa
    join public.schedule_items si on si.id = sa.schedule_item_id
    join public.project_role_members prm
      on prm.role_id = sa.role_id and prm.project_id = si.project_id
    join public.profiles p on p.id = auth.uid()
    where sa.schedule_item_id = p_item
      and sa.role_id is not null
      and (prm.profile_id = auth.uid() or prm.company_id = p.company_id)
  );
$$;
grant execute on function public.trade_sees_item_via_role(uuid) to authenticated;

-- Same resolution, keyed by an assignment row, so a trade can READ the
-- role-based assignment row that targets them (used by My Assignments and the
-- schedule avatar load).
create or replace function public.trade_sees_assignment_via_role(p_role uuid, p_item uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.schedule_items si
    join public.project_role_members prm
      on prm.role_id = p_role and prm.project_id = si.project_id
    join public.profiles p on p.id = auth.uid()
    where si.id = p_item
      and (prm.profile_id = auth.uid() or prm.company_id = p.company_id)
  );
$$;
grant execute on function public.trade_sees_assignment_via_role(uuid, uuid) to authenticated;

-- Extend the trade read policy on schedule_items with the role path. This can
-- only ADD visibility (it's OR'd), and only for items whose role resolves to
-- the trade — existing direct-assignment visibility is unchanged.
drop policy if exists schedule_items_trade_read on public.schedule_items;
create policy schedule_items_trade_read on public.schedule_items
  for select using (
    public.current_role_name() = 'trade'
    and (
      exists (
        select 1 from public.schedule_assignments sa
        left join public.profiles p on p.id = auth.uid()
        where sa.schedule_item_id = schedule_items.id
          and (sa.profile_id = auth.uid() or sa.company_id = p.company_id)
      )
      or public.trade_sees_item_via_role(schedule_items.id)
    )
  );

-- Extend assignment self-read with the role path so trades can read the
-- role-based rows that target them.
drop policy if exists schedule_assignments_self_read on public.schedule_assignments;
create policy schedule_assignments_self_read on public.schedule_assignments
  for select using (
    profile_id = (select auth.uid())
    or exists (
      select 1 from public.profiles p
      where p.id = (select auth.uid())
        and p.company_id = schedule_assignments.company_id
    )
    or (
      role_id is not null
      and public.trade_sees_assignment_via_role(role_id, schedule_item_id)
    )
  );

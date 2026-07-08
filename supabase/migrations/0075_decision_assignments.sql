-- Decision assignments: assign a selection (or change order) to people,
-- companies, or roles — so subs can see the selections they're assigned on.
--
-- Mirrors schedule_assignments (0001 + 0054): exactly one of
-- profile_id | company_id | role_id per row, role resolving through the
-- per-project role map. Trades gain READ on assigned, non-draft decisions
-- (and their choices/attachments) via a SECURITY DEFINER helper, the same
-- pattern as trade_sees_item_via_role.

create table if not exists public.decision_assignments (
  id uuid primary key default gen_random_uuid(),
  decision_id uuid not null references public.decisions(id) on delete cascade,
  profile_id uuid references public.profiles(id) on delete cascade,
  company_id uuid references public.companies(id) on delete cascade,
  role_id uuid references public.roles(id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint decision_assignments_one_assignee
    check (num_nonnulls(profile_id, company_id, role_id) = 1)
);

create unique index if not exists uq_decision_assignments_target
  on public.decision_assignments (decision_id, profile_id, company_id, role_id)
  nulls not distinct;
create index if not exists idx_dass_decision on public.decision_assignments(decision_id);
create index if not exists idx_dass_profile on public.decision_assignments(profile_id);
create index if not exists idx_dass_company on public.decision_assignments(company_id);
create index if not exists idx_dass_role on public.decision_assignments(role_id);

alter table public.decision_assignments enable row level security;

drop policy if exists dass_staff_all on public.decision_assignments;
create policy dass_staff_all on public.decision_assignments
  for all using (public.is_staff()) with check (public.is_staff());

-- A trade sees a decision when an assignment on it resolves to them: directly
-- (their profile / their company) or via a role filled by them or their
-- company on that project. SECURITY DEFINER to sidestep RLS-in-policy
-- recursion, mirroring trade_sees_item_via_role (0054).
create or replace function public.trade_sees_decision(p_decision uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.decision_assignments da
    join public.decisions d on d.id = da.decision_id
    join public.profiles p on p.id = auth.uid()
    left join public.project_role_members prm
      on prm.role_id = da.role_id and prm.project_id = d.project_id
    where da.decision_id = p_decision
      and (
        da.profile_id = auth.uid()
        or (da.company_id is not null and da.company_id = p.company_id)
        or (
          da.role_id is not null
          and (prm.profile_id = auth.uid() or prm.company_id = p.company_id)
        )
      )
  );
$$;
grant execute on function public.trade_sees_decision(uuid) to authenticated;

-- Trades can read the assignment rows that target them (for rendering).
drop policy if exists dass_self_read on public.decision_assignments;
create policy dass_self_read on public.decision_assignments
  for select using (
    profile_id = (select auth.uid())
    or exists (
      select 1 from public.profiles p
      where p.id = (select auth.uid())
        and p.company_id = decision_assignments.company_id
    )
    or (
      role_id is not null
      and exists (
        select 1
        from public.decisions d
        join public.project_role_members prm
          on prm.role_id = decision_assignments.role_id
         and prm.project_id = d.project_id
        join public.profiles p on p.id = (select auth.uid())
        where d.id = decision_assignments.decision_id
          and (prm.profile_id = p.id or prm.company_id = p.company_id)
      )
    )
  );

-- Trades read assigned decisions once they leave draft (same status gate as
-- clients — drafts stay internal).
drop policy if exists decisions_trade_read on public.decisions;
create policy decisions_trade_read on public.decisions
  for select using (
    public.current_role_name() = 'trade'
    and status in ('pending_client', 'approved', 'rejected')
    and public.trade_sees_decision(id)
  );

-- ...and the choices/attachments of those decisions (needed to act on an
-- approved selection). Cost line items stay staff-only.
drop policy if exists dch_trade_read on public.decision_choices;
create policy dch_trade_read on public.decision_choices
  for select using (
    exists (
      select 1 from public.decisions d
      where d.id = decision_choices.decision_id
        and public.current_role_name() = 'trade'
        and d.status in ('pending_client', 'approved', 'rejected')
        and public.trade_sees_decision(d.id)
    )
  );

drop policy if exists da_trade_read on public.decision_attachments;
create policy da_trade_read on public.decision_attachments
  for select using (
    exists (
      select 1 from public.decisions d
      where d.id = decision_attachments.decision_id
        and public.current_role_name() = 'trade'
        and d.status in ('pending_client', 'approved', 'rejected')
        and public.trade_sees_decision(d.id)
    )
  );

-- Extend the trade storage read policy so signed-URL access to decision
-- attachment blobs works for assigned trades (previously covered only
-- schedule_item_attachments).
drop policy if exists project_files_trade_read on storage.objects;
create policy project_files_trade_read on storage.objects
  for select using (
    bucket_id = 'project-files'
    and public.current_role_name() = 'trade'
    and (
      exists (
        select 1
        from public.schedule_item_attachments sia
        join public.schedule_assignments sa on sa.schedule_item_id = sia.schedule_item_id
        left join public.profiles p on p.id = auth.uid()
        where sia.storage_path = storage.objects.name
          and sia.storage_bucket = storage.objects.bucket_id
          and (sa.profile_id = auth.uid() or sa.company_id = p.company_id)
      )
      or exists (
        select 1
        from public.decision_attachments da
        join public.decisions d on d.id = da.decision_id
        where da.storage_path = storage.objects.name
          and da.storage_bucket = storage.objects.bucket_id
          and d.status in ('pending_client', 'approved', 'rejected')
          and public.trade_sees_decision(d.id)
      )
    )
  );

-- Trades can read the projects row for jobs they're assigned to.
--
-- Without this, every trade-facing surface that joins through projects came
-- up empty or 404'd: /my-assignments embeds projects!inner (RLS-dropped rows),
-- and /projects/{id}/... layouts call notFound() when the projects read
-- returns nothing. 0075's decision assignments were unreachable end-to-end,
-- and the schedule section of /my-assignments had the same latent gap —
-- trades were only visible-by-accident when staff also added them to the
-- client-oriented project_members list.
--
-- Same SECURITY DEFINER pattern as trade_sees_item_via_role /
-- trade_sees_decision: visibility flows from an assignment that resolves to
-- the caller directly or via the project's role map.

create or replace function public.trade_sees_project(p_project uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    -- Direct schedule assignment (their profile or their company).
    exists (
      select 1
      from public.schedule_assignments sa
      join public.schedule_items si on si.id = sa.schedule_item_id
      join public.profiles p on p.id = auth.uid()
      where si.project_id = p_project
        and (
          sa.profile_id = auth.uid()
          or (sa.company_id is not null and sa.company_id = p.company_id)
        )
    )
    -- A role on this project is filled by them or their company.
    or exists (
      select 1
      from public.project_role_members prm
      join public.profiles p on p.id = auth.uid()
      where prm.project_id = p_project
        and (
          prm.profile_id = auth.uid()
          or (prm.company_id is not null and prm.company_id = p.company_id)
        )
    )
    -- Assigned to a non-draft decision (selection) on this project.
    or exists (
      select 1
      from public.decisions d
      where d.project_id = p_project
        and d.status in ('pending_client', 'approved', 'rejected')
        and public.trade_sees_decision(d.id)
    );
$$;
grant execute on function public.trade_sees_project(uuid) to authenticated;

drop policy if exists projects_trade_read on public.projects;
create policy projects_trade_read on public.projects
  for select using (
    public.current_role_name() = 'trade'
    and public.trade_sees_project(id)
  );

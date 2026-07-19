-- 0119: Stage S (part 4) — sandbox org hard-delete RPC.
--
-- Backs the daily /api/cron/sandbox-cleanup sweep: once a lapsed trial is 30
-- days past its sandbox_expires_at, its data is torn down permanently. The ROOT
-- org_id FKs (projects, companies, cost_codes, roles, app_settings, …) are plain
-- references with NO ON DELETE CASCADE, so a bare `delete from organizations`
-- errors on the first child. This function deletes the org's data in dependency
-- order so the teardown succeeds atomically (one transaction), and returns the
-- member profile ids so the cron can delete the matching auth users.
--
-- SAFETY: it refuses any org that isn't a sandbox trial — status must be
-- 'sandbox_expired' or 'sandbox_active'. An active_subscriber (Hines, every
-- operator-provisioned builder) can NEVER be deleted through this path, even if
-- the caller points it at one. SERVICE-ROLE-ONLY (no authenticated/anon grant).

create or replace function public.delete_organization(p_org uuid)
returns table (deleted_member uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_status text;
  v_project_ids uuid[];
begin
  select status into v_status from public.organizations where id = p_org;
  if v_status is null then
    return; -- already gone — idempotent
  end if;
  if v_status not in ('sandbox_expired', 'sandbox_active') then
    raise exception
      'Refusing to delete non-sandbox organization % (status %)', p_org, v_status;
  end if;

  -- Snapshot the members before organization_members cascades away, so the
  -- caller can clean up their auth users. `return query` appends to the result
  -- set but does NOT exit the function — the deletes below still run.
  return query
    select om.profile_id from public.organization_members om where om.org_id = p_org;

  -- Snapshot the org's project ids before the cascade removes them: the audit /
  -- trash / QBO-mirror tables key off project_id as a BARE uuid (no FK to
  -- projects — history/trash keep it bare so project deletes can't deadlock), so
  -- the projects cascade never reaches them. Without an explicit purge a
  -- "permanent" delete would strand their snapshots (full row payloads, actor
  -- names, invoice data) forever.
  select array_agg(id) into v_project_ids from public.projects where org_id = p_org;

  -- Teardown in dependency order. Projects first: their many children cascade
  -- via project_id, which also clears the only blockers on companies/cost_codes
  -- (purchase_orders → companies, and project_budget_lines / project_cost_actuals
  -- → cost_codes are all project children, deleted by that cascade).
  delete from public.projects             where org_id = p_org;

  -- Now purge the bare-uuid project references the cascade couldn't reach. Runs
  -- AFTER the projects delete so any history rows the cascade itself recorded
  -- (record_project_history fires on child deletes) are swept too.
  if v_project_ids is not null then
    delete from public.project_history where project_id = any(v_project_ids);
    delete from public.deleted_items    where project_id = any(v_project_ids);
    delete from public.qbo_invoices     where project_id = any(v_project_ids);
  end if;

  delete from public.insurance_documents  where org_id = p_org; -- cascades insurance_policies
  delete from public.companies            where org_id = p_org;
  delete from public.cost_codes           where org_id = p_org;
  -- Flat root tables with no blocking children of their own.
  delete from public.roles                where org_id = p_org;
  delete from public.app_settings         where org_id = p_org;
  delete from public.purchasing_templates where org_id = p_org;
  delete from public.rental_properties    where org_id = p_org;
  delete from public.qbo_connection       where org_id = p_org;
  delete from public.feedback_requests    where org_id = p_org;
  delete from public.communications       where org_id = p_org;
  delete from public.utility_requests     where org_id = p_org;

  -- The org row itself — cascades org_integrations + organization_members and
  -- nulls any profiles.active_org_id still pointing here.
  delete from public.organizations        where id = p_org;
end;
$$;

revoke all on function delete_organization(uuid) from public;
revoke execute on function delete_organization(uuid) from anon;
revoke execute on function delete_organization(uuid) from authenticated;
grant execute on function delete_organization(uuid) to service_role;

comment on function public.delete_organization(uuid) is
  'Hard-delete a SANDBOX org (status sandbox_expired/sandbox_active only) and all org-scoped data in FK dependency order; returns member profile ids for auth-user cleanup. Service-role only. Backs the S4 sandbox-cleanup cron.';

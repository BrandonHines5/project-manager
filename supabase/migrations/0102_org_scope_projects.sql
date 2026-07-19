-- 0102: Stage B2 module 3 — org-scope projects + every project child.
--
-- The big one. Every staff policy on projects and its child/grandchild tables
-- was a bare is_staff(), which after B1 means staff of ANY org could read and
-- write another org's jobs. This migration layers the org condition on top:
-- projects gate on is_org_member(org_id); children resolve their org through
-- the parent chain via new SECURITY DEFINER helpers. Client/trade policies
-- are untouched — they're already row-scoped by project_members / company
-- assignment (belt-and-suspenders per docs/multi-tenant-plan.md).
--
-- Why one definer helper per parent chain instead of inline EXISTS subqueries:
-- a policy's subquery re-enters the referenced table's RLS, and two of those
-- references complete cycles that Postgres rejects with "infinite recursion
-- detected" — schedule_items↔schedule_assignments (schedule_items_trade_read
-- reads schedule_assignments) and bid_packages↔bid_recipients (bp_trade_read
-- reads bid_recipients). Definer functions run as the table owner, skipping
-- RLS on the parent lookup, exactly like the existing trade_sees_* helpers.
--
-- Also here:
-- - utility_requests gains org_id. B1 skipped it, but its project_id is
--   nullable and every live row is unparented (global CAW/Lumber One
--   requests), so it's really an unparented root like insurance_documents.
--   It KEEPS its bridge default until the utilities module becomes org-aware
--   (B3 moves utility configs into org settings) — same deal as
--   insurance_documents' default, which stays until B4.
-- - projects drops its bridge default; the three insert paths (createProject,
--   duplicateProject, warranty addCrmProject) now stamp org_id explicitly.
--
-- project_history / deleted_items / qbo_invoices carry bare-uuid project_ids
-- (no FK): rows whose project is gone become invisible under the new SELECT
-- policies, which is fine — every reader is a per-project page that needs the
-- project row anyway. Writes to those tables are definer-trigger or
-- service-role and unaffected.

-- Helpers: is this project (or this row's project, via its parent chain) in
-- one of the caller's orgs? ---------------------------------------------------

create or replace function public.project_in_my_org(p_project uuid)
returns boolean
language sql
stable security definer
set search_path to 'public'
as $$
  select exists (
    select 1
    from projects p
    join organization_members m on m.org_id = p.org_id
    where p.id = p_project and m.profile_id = auth.uid()
  );
$$;

create or replace function public.schedule_item_in_my_org(p_item uuid)
returns boolean
language sql
stable security definer
set search_path to 'public'
as $$
  select exists (
    select 1
    from schedule_items si
    join projects p on p.id = si.project_id
    join organization_members m on m.org_id = p.org_id
    where si.id = p_item and m.profile_id = auth.uid()
  );
$$;

create or replace function public.decision_in_my_org(p_decision uuid)
returns boolean
language sql
stable security definer
set search_path to 'public'
as $$
  select exists (
    select 1
    from decisions d
    join projects p on p.id = d.project_id
    join organization_members m on m.org_id = p.org_id
    where d.id = p_decision and m.profile_id = auth.uid()
  );
$$;

create or replace function public.daily_log_in_my_org(p_log uuid)
returns boolean
language sql
stable security definer
set search_path to 'public'
as $$
  select exists (
    select 1
    from daily_logs dl
    join projects p on p.id = dl.project_id
    join organization_members m on m.org_id = p.org_id
    where dl.id = p_log and m.profile_id = auth.uid()
  );
$$;

create or replace function public.bid_package_in_my_org(p_package uuid)
returns boolean
language sql
stable security definer
set search_path to 'public'
as $$
  select exists (
    select 1
    from bid_packages bp
    join projects p on p.id = bp.project_id
    join organization_members m on m.org_id = p.org_id
    where bp.id = p_package and m.profile_id = auth.uid()
  );
$$;

create or replace function public.bid_recipient_in_my_org(p_recipient uuid)
returns boolean
language sql
stable security definer
set search_path to 'public'
as $$
  select exists (
    select 1
    from bid_recipients br
    join bid_packages bp on bp.id = br.bid_package_id
    join projects p on p.id = bp.project_id
    join organization_members m on m.org_id = p.org_id
    where br.id = p_recipient and m.profile_id = auth.uid()
  );
$$;

create or replace function public.purchase_order_in_my_org(p_po uuid)
returns boolean
language sql
stable security definer
set search_path to 'public'
as $$
  select exists (
    select 1
    from purchase_orders po
    join projects p on p.id = po.project_id
    join organization_members m on m.org_id = p.org_id
    where po.id = p_po and m.profile_id = auth.uid()
  );
$$;

create or replace function public.payment_in_my_org(p_payment uuid)
returns boolean
language sql
stable security definer
set search_path to 'public'
as $$
  select exists (
    select 1
    from project_payments pp
    join projects p on p.id = pp.project_id
    join organization_members m on m.org_id = p.org_id
    where pp.id = p_payment and m.profile_id = auth.uid()
  );
$$;

-- Supabase default-grants EXECUTE to anon/authenticated directly (not via
-- PUBLIC), so anon needs its own revoke.
do $$
declare fn text;
begin
  foreach fn in array array[
    'project_in_my_org', 'schedule_item_in_my_org', 'decision_in_my_org',
    'daily_log_in_my_org', 'bid_package_in_my_org', 'bid_recipient_in_my_org',
    'purchase_order_in_my_org', 'payment_in_my_org'
  ]
  loop
    execute format('revoke all on function %I(uuid) from public', fn);
    execute format('revoke execute on function %I(uuid) from anon', fn);
    execute format('grant execute on function %I(uuid) to authenticated', fn);
  end loop;
end $$;

-- projects ------------------------------------------------------------------

drop policy projects_staff_all on projects;
create policy projects_staff_all on projects
  as permissive for all
  using (is_staff() and is_org_member(org_id))
  with check (is_staff() and is_org_member(org_id));

-- Direct children (project_id on the row) -----------------------------------

drop policy schedule_items_staff_all on schedule_items;
create policy schedule_items_staff_all on schedule_items
  as permissive for all
  using (is_staff() and project_in_my_org(project_id))
  with check (is_staff() and project_in_my_org(project_id));

drop policy decisions_staff_all on decisions;
create policy decisions_staff_all on decisions
  as permissive for all
  using (is_staff() and project_in_my_org(project_id))
  with check (is_staff() and project_in_my_org(project_id));

drop policy daily_logs_staff_all on daily_logs;
create policy daily_logs_staff_all on daily_logs
  as permissive for all
  using (is_staff() and project_in_my_org(project_id))
  with check (is_staff() and project_in_my_org(project_id));

drop policy pf_staff_all on project_files;
create policy pf_staff_all on project_files
  as permissive for all
  using (is_staff() and project_in_my_org(project_id))
  with check (is_staff() and project_in_my_org(project_id));

drop policy pp_staff_all on project_payments;
create policy pp_staff_all on project_payments
  as permissive for all
  using (is_staff() and project_in_my_org(project_id))
  with check (is_staff() and project_in_my_org(project_id));

drop policy project_members_staff_all on project_members;
create policy project_members_staff_all on project_members
  as permissive for all
  using (is_staff() and project_in_my_org(project_id))
  with check (is_staff() and project_in_my_org(project_id));

drop policy prm_staff_all on project_role_members;
create policy prm_staff_all on project_role_members
  as permissive for all
  using (is_staff() and project_in_my_org(project_id))
  with check (is_staff() and project_in_my_org(project_id));

drop policy pbl_staff_all on project_budget_lines;
create policy pbl_staff_all on project_budget_lines
  as permissive for all
  using (is_staff() and project_in_my_org(project_id))
  with check (is_staff() and project_in_my_org(project_id));

drop policy pca_staff_all on project_cost_actuals;
create policy pca_staff_all on project_cost_actuals
  as permissive for all
  using (is_staff() and project_in_my_org(project_id))
  with check (is_staff() and project_in_my_org(project_id));

drop policy bp_staff_all on bid_packages;
create policy bp_staff_all on bid_packages
  as permissive for all
  using (is_staff() and project_in_my_org(project_id))
  with check (is_staff() and project_in_my_org(project_id));

drop policy po_staff_all on purchase_orders;
create policy po_staff_all on purchase_orders
  as permissive for all
  using (is_staff() and project_in_my_org(project_id))
  with check (is_staff() and project_in_my_org(project_id));

drop policy client_invites_staff_all on client_invites;
create policy client_invites_staff_all on client_invites
  as permissive for all
  using (is_staff() and project_in_my_org(project_id))
  with check (is_staff() and project_in_my_org(project_id));

drop policy qi_staff_read on qbo_invoices;
create policy qi_staff_read on qbo_invoices
  for select
  using (is_staff() and project_in_my_org(project_id));

drop policy ph_staff_read on project_history;
create policy ph_staff_read on project_history
  for select
  using (is_staff() and project_in_my_org(project_id));

drop policy di_staff_read on deleted_items;
create policy di_staff_read on deleted_items
  for select
  using (is_staff() and project_in_my_org(project_id));

-- Schedule grandchildren (via schedule_items) --------------------------------

drop policy schedule_assignments_staff_all on schedule_assignments;
create policy schedule_assignments_staff_all on schedule_assignments
  as permissive for all
  using (is_staff() and schedule_item_in_my_org(schedule_item_id))
  with check (is_staff() and schedule_item_in_my_org(schedule_item_id));

drop policy schedule_delays_staff_all on schedule_delays;
create policy schedule_delays_staff_all on schedule_delays
  as permissive for all
  using (is_staff() and schedule_item_in_my_org(schedule_item_id))
  with check (is_staff() and schedule_item_in_my_org(schedule_item_id));

-- Both ends of a predecessor edge live in one project; gate on item_id.
drop policy schedule_predecessors_staff_all on schedule_predecessors;
create policy schedule_predecessors_staff_all on schedule_predecessors
  as permissive for all
  using (is_staff() and schedule_item_in_my_org(item_id))
  with check (is_staff() and schedule_item_in_my_org(item_id));

drop policy todo_checklist_items_staff_all on todo_checklist_items;
create policy todo_checklist_items_staff_all on todo_checklist_items
  as permissive for all
  using (is_staff() and schedule_item_in_my_org(schedule_item_id))
  with check (is_staff() and schedule_item_in_my_org(schedule_item_id));

drop policy sia_staff_all on schedule_item_attachments;
create policy sia_staff_all on schedule_item_attachments
  as permissive for all
  using (is_staff() and schedule_item_in_my_org(schedule_item_id))
  with check (is_staff() and schedule_item_in_my_org(schedule_item_id));

drop policy sic_staff_all on schedule_item_comments;
create policy sic_staff_all on schedule_item_comments
  as permissive for all
  using (is_staff() and schedule_item_in_my_org(schedule_item_id))
  with check (is_staff() and schedule_item_in_my_org(schedule_item_id));

-- Decision grandchildren (via decisions) -------------------------------------

drop policy dch_staff_all on decision_choices;
create policy dch_staff_all on decision_choices
  as permissive for all
  using (is_staff() and decision_in_my_org(decision_id))
  with check (is_staff() and decision_in_my_org(decision_id));

drop policy dci_staff_all on decision_cost_items;
create policy dci_staff_all on decision_cost_items
  as permissive for all
  using (is_staff() and decision_in_my_org(decision_id))
  with check (is_staff() and decision_in_my_org(decision_id));

drop policy da_staff_all on decision_attachments;
create policy da_staff_all on decision_attachments
  as permissive for all
  using (is_staff() and decision_in_my_org(decision_id))
  with check (is_staff() and decision_in_my_org(decision_id));

drop policy dc_staff_all on decision_comments;
create policy dc_staff_all on decision_comments
  as permissive for all
  using (is_staff() and decision_in_my_org(decision_id))
  with check (is_staff() and decision_in_my_org(decision_id));

drop policy dass_staff_all on decision_assignments;
create policy dass_staff_all on decision_assignments
  as permissive for all
  using (is_staff() and decision_in_my_org(decision_id))
  with check (is_staff() and decision_in_my_org(decision_id));

drop policy dft_staff_all on decision_followup_templates;
create policy dft_staff_all on decision_followup_templates
  as permissive for all
  using (is_staff() and decision_in_my_org(decision_id))
  with check (is_staff() and decision_in_my_org(decision_id));

drop policy dfm_staff_all on decision_followup_materializations;
create policy dfm_staff_all on decision_followup_materializations
  as permissive for all
  using (is_staff() and decision_in_my_org(decision_id))
  with check (is_staff() and decision_in_my_org(decision_id));

-- Daily-log grandchildren (via daily_logs) -----------------------------------

drop policy dla_staff_all on daily_log_attachments;
create policy dla_staff_all on daily_log_attachments
  as permissive for all
  using (is_staff() and daily_log_in_my_org(daily_log_id))
  with check (is_staff() and daily_log_in_my_org(daily_log_id));

drop policy dlc_staff_all on daily_log_comments;
create policy dlc_staff_all on daily_log_comments
  as permissive for all
  using (is_staff() and daily_log_in_my_org(daily_log_id))
  with check (is_staff() and daily_log_in_my_org(daily_log_id));

drop policy dlsos_staff_all on daily_log_subs_on_site;
create policy dlsos_staff_all on daily_log_subs_on_site
  as permissive for all
  using (is_staff() and daily_log_in_my_org(daily_log_id))
  with check (is_staff() and daily_log_in_my_org(daily_log_id));

-- Bid grandchildren (via bid_packages / bid_recipients) ----------------------

drop policy bpli_staff_all on bid_package_line_items;
create policy bpli_staff_all on bid_package_line_items
  as permissive for all
  using (is_staff() and bid_package_in_my_org(bid_package_id))
  with check (is_staff() and bid_package_in_my_org(bid_package_id));

drop policy br_staff_all on bid_recipients;
create policy br_staff_all on bid_recipients
  as permissive for all
  using (is_staff() and bid_package_in_my_org(bid_package_id))
  with check (is_staff() and bid_package_in_my_org(bid_package_id));

drop policy bpa_staff_all on bid_package_attachments;
create policy bpa_staff_all on bid_package_attachments
  as permissive for all
  using (is_staff() and bid_package_in_my_org(bid_package_id))
  with check (is_staff() and bid_package_in_my_org(bid_package_id));

drop policy bliq_staff_all on bid_line_item_quotes;
create policy bliq_staff_all on bid_line_item_quotes
  as permissive for all
  using (is_staff() and bid_recipient_in_my_org(bid_recipient_id))
  with check (is_staff() and bid_recipient_in_my_org(bid_recipient_id));

drop policy bc_staff_all on bid_comments;
create policy bc_staff_all on bid_comments
  as permissive for all
  using (is_staff() and bid_recipient_in_my_org(bid_recipient_id))
  with check (is_staff() and bid_recipient_in_my_org(bid_recipient_id));

-- PO grandchildren (via purchase_orders) -------------------------------------

drop policy poli_staff_all on po_line_items;
create policy poli_staff_all on po_line_items
  as permissive for all
  using (is_staff() and purchase_order_in_my_org(purchase_order_id))
  with check (is_staff() and purchase_order_in_my_org(purchase_order_id));

drop policy poa_staff_all on po_attachments;
create policy poa_staff_all on po_attachments
  as permissive for all
  using (is_staff() and purchase_order_in_my_org(purchase_order_id))
  with check (is_staff() and purchase_order_in_my_org(purchase_order_id));

drop policy poc_staff_all on po_comments;
create policy poc_staff_all on po_comments
  as permissive for all
  using (is_staff() and purchase_order_in_my_org(purchase_order_id))
  with check (is_staff() and purchase_order_in_my_org(purchase_order_id));

-- Payment audit (via project_payments) ---------------------------------------

drop policy payment_audit_staff_read on payment_audit;
create policy payment_audit_staff_read on payment_audit
  for select
  using (is_staff() and payment_in_my_org(payment_id));

-- utility_requests: unparented root missed in B1 -----------------------------
-- Every live row has project_id null (global CAW/Lumber One requests), so it
-- can't resolve org through a parent. Stamp it like the B1 roots. The bridge
-- default STAYS until the utilities module becomes org-aware (B3 moves those
-- configs into org settings) — Hines inserts keep working unchanged, and
-- other orgs' staff simply can't use the Hines-specific utilities module yet.

alter table utility_requests
  add column if not exists org_id uuid not null
    default '018f6f2a-4c1e-4b8e-9d3a-7c5b2e8a1f10'
    references organizations(id);
create index if not exists utility_requests_org_idx on utility_requests(org_id);

drop policy utility_requests_staff_all on utility_requests;
create policy utility_requests_staff_all on utility_requests
  as permissive for all
  using (is_staff() and is_org_member(org_id))
  with check (is_staff() and is_org_member(org_id));

-- Bridge default off for projects — createProject, duplicateProject, and the
-- warranty addCrmProject path stamp org_id explicitly from this migration's
-- companion code change.

alter table projects alter column org_id drop default;

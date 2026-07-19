-- 0100: Stage B2 module 1 — org-scope the catalog tables' RLS.
--
-- Adds the org condition to every policy on roles, cost_codes,
-- purchasing_templates, rental_properties (+ rental_items via parent), and
-- feedback_requests, and drops those tables' bridge defaults (their insert
-- paths now stamp org_id explicitly via lib/org.ts:getActiveOrgId).
--
-- All profiles are members of the Hines org (0099 backfill), so behavior for
-- existing users is unchanged; users of OTHER orgs (once they exist) see and
-- touch only their own catalog rows. See docs/multi-tenant-plan.md.

-- roles ----------------------------------------------------------------------

drop policy roles_read_all on roles;
create policy roles_read_all on roles
  for select to authenticated
  using (is_org_member(org_id));

drop policy roles_staff_all on roles;
create policy roles_staff_all on roles
  as permissive for all
  using (is_staff() and is_org_member(org_id))
  with check (is_staff() and is_org_member(org_id));

-- cost_codes -----------------------------------------------------------------

drop policy cost_codes_read_all on cost_codes;
create policy cost_codes_read_all on cost_codes
  for select to authenticated
  using (is_org_member(org_id));

drop policy cost_codes_staff_write on cost_codes;
create policy cost_codes_staff_write on cost_codes
  for insert to authenticated
  with check (is_staff() and is_org_member(org_id));

drop policy cost_codes_staff_update on cost_codes;
create policy cost_codes_staff_update on cost_codes
  for update to authenticated
  using (is_staff() and is_org_member(org_id))
  with check (is_staff() and is_org_member(org_id));

drop policy cost_codes_staff_delete on cost_codes;
create policy cost_codes_staff_delete on cost_codes
  for delete to authenticated
  using (is_staff() and is_org_member(org_id));

-- purchasing_templates -------------------------------------------------------

drop policy ptmpl_staff_all on purchasing_templates;
create policy ptmpl_staff_all on purchasing_templates
  as permissive for all
  using (is_staff() and is_org_member(org_id))
  with check (is_staff() and is_org_member(org_id));

-- rental_properties + rental_items (child scopes via parent) -----------------

drop policy rental_properties_staff_all on rental_properties;
create policy rental_properties_staff_all on rental_properties
  as permissive for all
  using (is_staff() and is_org_member(org_id))
  with check (is_staff() and is_org_member(org_id));

drop policy rental_items_staff_all on rental_items;
create policy rental_items_staff_all on rental_items
  as permissive for all
  using (
    is_staff()
    and exists (
      select 1 from rental_properties rp
      where rp.id = rental_items.rental_property_id
        and is_org_member(rp.org_id)
    )
  )
  with check (
    is_staff()
    and exists (
      select 1 from rental_properties rp
      where rp.id = rental_items.rental_property_id
        and is_org_member(rp.org_id)
    )
  );

-- feedback_requests ----------------------------------------------------------

drop policy feedback_insert_self on feedback_requests;
create policy feedback_insert_self on feedback_requests
  for insert to authenticated
  with check (
    submitted_by_id = (select auth.uid())
    and is_org_member(org_id)
  );

drop policy feedback_read_own on feedback_requests;
create policy feedback_read_own on feedback_requests
  for select to authenticated
  using (
    submitted_by_id = (select auth.uid())
    and is_org_member(org_id)
  );

drop policy feedback_staff_read on feedback_requests;
create policy feedback_staff_read on feedback_requests
  for select
  using (is_staff() and is_org_member(org_id));

drop policy feedback_staff_update on feedback_requests;
create policy feedback_staff_update on feedback_requests
  for update
  using (is_staff() and is_org_member(org_id))
  with check (is_staff() and is_org_member(org_id));

drop policy feedback_staff_delete on feedback_requests;
create policy feedback_staff_delete on feedback_requests
  for delete
  using (is_staff() and is_org_member(org_id));

-- Bridge defaults off — these modules' inserts are org-aware from this
-- migration's companion code change (lib/org.ts stamping).

alter table roles                alter column org_id drop default;
alter table cost_codes           alter column org_id drop default;
alter table purchasing_templates alter column org_id drop default;
alter table rental_properties    alter column org_id drop default;
alter table feedback_requests    alter column org_id drop default;

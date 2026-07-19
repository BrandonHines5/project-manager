-- 0108: Stage B5 (part 1) — active-org selection + org-admin foundation.
--
-- Multi-org membership becomes REAL here: `profiles.active_org_id` records
-- which of a user's orgs they're currently working in, and lib/org.ts's
-- getActiveOrgId now honors it (falling back to the earliest membership when
-- unset or stale — exactly the old behavior for every single-org user, which
-- today is everyone). The avatar-menu switcher only renders for users with
-- more than one membership, so nothing changes visually until a second
-- membership exists.
--
-- Also the first ORG-ADMIN write surface: organizations updates (name /
-- settings — branding, utilities config) open to the org's owner/admin
-- members via the new org_admin() helper. Membership WRITES stay
-- service-role-only until B5's member-management RPCs land with their
-- last-owner / privilege-escalation guards.

alter table profiles
  add column active_org_id uuid references organizations(id) on delete set null;

comment on column profiles.active_org_id is
  'Which of the user''s orgs they are working in (B5). Must be one of their organization_members rows to take effect — getActiveOrgId validates and falls back to the earliest membership.';

-- Helper: is the caller an owner/admin member of this org?
create or replace function public.org_admin(org uuid)
returns boolean
language sql
stable security definer
set search_path to 'public'
as $$
  select exists (
    select 1 from organization_members m
    where m.org_id = org
      and m.profile_id = auth.uid()
      and m.member_role in ('owner', 'admin')
  );
$$;

-- Supabase default-grants EXECUTE to anon/authenticated directly (not via
-- PUBLIC), so anon needs its own revoke.
revoke all on function org_admin(uuid) from public;
revoke execute on function org_admin(uuid) from anon;
grant execute on function org_admin(uuid) to authenticated;

-- Org owners/admins can edit their org's row (name, slug, settings). The
-- with_check keeps an update from re-homing the row to another id; inserts
-- and deletes stay service-role-only (org creation is provisioning, org
-- deletion is a support operation).
create policy orgs_admin_update on organizations
  for update
  using (org_admin(id))
  with check (org_admin(id));

-- 0124: Feedback & Requests routes to the platform operator.
--
-- Pre-multi-tenant, "Request an update" was an internal Hines channel: staff
-- triaged their own org's requests. With builder orgs live, the module's
-- purpose forks:
--   * For the LEGACY (Hines) org it stays the internal improvements queue —
--     Hines staff triage Hines rows exactly as before.
--   * For every OTHER org it is a support channel TO the platform operator:
--     requests surface in the operator's own Feedback & Requests queue, and
--     the status / admin-notes reply comes from the operator, not from the
--     builder's own staff.
--
-- This migration adds the DB half: a platform-admin helper + read access to
-- every org's rows, and a triage (update/delete) tightening so builder staff
-- can no longer rewrite the platform's triage state on their org's rows.
-- (Submitting and reading stay unchanged: anyone signed in files as
-- themselves; submitters track their own rows; org staff still read their
-- org's rows so a builder owner can see what their team asked for.)

-- ---------------------------------------------------------------------------
-- is_platform_admin(): is the caller the platform operator — an OWNER member
-- of the legacy (Hines) org? Mirrors the app-layer `platformAdmin` gate
-- (app layout / lib/org.ts:isLegacyOrgOwner) so RLS and UI can't drift.
-- Security definer like is_org_member/org_admin: reads membership without RLS
-- recursion. The literal Hines org id is intentional — same constant as the
-- 0099 bridge defaults and 0111's default seed org.
-- ---------------------------------------------------------------------------

create or replace function public.is_platform_admin()
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.organization_members m
    where m.org_id = '018f6f2a-4c1e-4b8e-9d3a-7c5b2e8a1f10'
      and m.profile_id = auth.uid()
      and m.member_role = 'owner'
  );
$$;

-- Supabase default-grants EXECUTE to anon/authenticated directly (not via
-- PUBLIC), so anon needs its own revoke.
revoke all on function public.is_platform_admin() from public;
revoke execute on function public.is_platform_admin() from anon;
grant execute on function public.is_platform_admin() to authenticated;

-- ---------------------------------------------------------------------------
-- feedback_requests: platform admin reads every org's rows; triage
-- (update/delete) is legacy staff on legacy rows, or the platform admin
-- anywhere. Submit (feedback_insert_self), submitter read (feedback_read_own)
-- and org-staff read (feedback_staff_read) are unchanged.
-- ---------------------------------------------------------------------------

drop policy if exists feedback_platform_read on public.feedback_requests;
create policy feedback_platform_read on public.feedback_requests
  for select
  using (public.is_platform_admin());

drop policy if exists feedback_staff_update on public.feedback_requests;
create policy feedback_staff_update on public.feedback_requests
  for update
  using (
    public.is_platform_admin()
    or (
      public.is_staff()
      and org_id = '018f6f2a-4c1e-4b8e-9d3a-7c5b2e8a1f10'
      and public.is_org_member(org_id)
    )
  )
  with check (
    public.is_platform_admin()
    or (
      public.is_staff()
      and org_id = '018f6f2a-4c1e-4b8e-9d3a-7c5b2e8a1f10'
      and public.is_org_member(org_id)
    )
  );

drop policy if exists feedback_staff_delete on public.feedback_requests;
create policy feedback_staff_delete on public.feedback_requests
  for delete
  using (
    public.is_platform_admin()
    or (
      public.is_staff()
      and org_id = '018f6f2a-4c1e-4b8e-9d3a-7c5b2e8a1f10'
      and public.is_org_member(org_id)
    )
  );

-- ---------------------------------------------------------------------------
-- organizations: the platform admin can read every org row (name only is what
-- the app needs — the Organization column on the operator's feedback queue
-- embeds organizations(name) through the session client). Members' own-org
-- read (orgs_member_read) is unchanged; policies OR together.
-- ---------------------------------------------------------------------------

drop policy if exists orgs_platform_read on public.organizations;
create policy orgs_platform_read on public.organizations
  for select
  using (public.is_platform_admin());

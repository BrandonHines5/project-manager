-- 0110: Stage B5 (part 3) — org member management RPCs.
--
-- organization_members writes stop being service-role-only: owner/admin
-- members manage their org's roster through two SECURITY DEFINER RPCs that
-- carry the guards RLS alone can't express. The permission matrix:
--
--   * OWNERS manage everyone: grant/revoke any role (including owner) and
--     remove any member.
--   * ADMINS manage NON-OWNERS: set member <-> admin and remove them. They
--     can never touch an owner row or grant/revoke the owner role.
--   * LAST-OWNER protection: the only owner of an org can't be demoted or
--     removed — an org must always keep at least one owner. A per-org
--     advisory lock (slot 5; project RPCs use 0-2) makes the check atomic
--     under concurrent demotions.
--
-- Enrollment (adding NEW members) intentionally stays out: inviteTeamMember /
-- client invite acceptance already enroll via the admin client, and cross-org
-- email invites are a later B5 slice. These RPCs only manage EXISTING rows.

create or replace function public.set_org_member_role(
  p_org uuid,
  p_profile uuid,
  p_role text
) returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  caller_role text;
  target_role text;
  owner_count int;
begin
  if p_role not in ('owner', 'admin', 'member') then
    raise exception 'Invalid role.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_org::text, 5));

  select member_role into caller_role
  from organization_members
  where org_id = p_org and profile_id = auth.uid();
  if caller_role is null or caller_role not in ('owner', 'admin') then
    raise exception 'Only organization owners and admins can manage members.';
  end if;

  select member_role into target_role
  from organization_members
  where org_id = p_org and profile_id = p_profile;
  if target_role is null then
    raise exception 'That person is not a member of this organization.';
  end if;
  if target_role = p_role then
    return;
  end if;

  -- Owner grants/revocations are owner-only, in both directions.
  if (target_role = 'owner' or p_role = 'owner') and caller_role <> 'owner' then
    raise exception 'Only an owner can change owner roles.';
  end if;

  if target_role = 'owner' then
    select count(*) into owner_count
    from organization_members
    where org_id = p_org and member_role = 'owner';
    if owner_count <= 1 then
      raise exception 'An organization must keep at least one owner.';
    end if;
  end if;

  update organization_members
  set member_role = p_role
  where org_id = p_org and profile_id = p_profile;
end;
$$;

create or replace function public.remove_org_member(
  p_org uuid,
  p_profile uuid
) returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  caller_role text;
  target_role text;
  owner_count int;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_org::text, 5));

  select member_role into caller_role
  from organization_members
  where org_id = p_org and profile_id = auth.uid();
  if caller_role is null or caller_role not in ('owner', 'admin') then
    raise exception 'Only organization owners and admins can manage members.';
  end if;

  select member_role into target_role
  from organization_members
  where org_id = p_org and profile_id = p_profile;
  if target_role is null then
    raise exception 'That person is not a member of this organization.';
  end if;

  if target_role = 'owner' then
    if caller_role <> 'owner' then
      raise exception 'Only an owner can remove an owner.';
    end if;
    select count(*) into owner_count
    from organization_members
    where org_id = p_org and member_role = 'owner';
    if owner_count <= 1 then
      raise exception 'An organization must keep at least one owner.';
    end if;
  end if;

  delete from organization_members
  where org_id = p_org and profile_id = p_profile;

  -- A stale active-org selection would silently fall back anyway
  -- (getActiveOrgId validates), but clear it so the DB doesn't keep
  -- pointing at an org the user no longer belongs to.
  update profiles
  set active_org_id = null
  where id = p_profile and active_org_id = p_org;
end;
$$;

-- Supabase default-grants EXECUTE to anon/authenticated directly (not via
-- PUBLIC), so anon needs its own revoke.
revoke all on function set_org_member_role(uuid, uuid, text) from public;
revoke execute on function set_org_member_role(uuid, uuid, text) from anon;
grant execute on function set_org_member_role(uuid, uuid, text) to authenticated;

revoke all on function remove_org_member(uuid, uuid) from public;
revoke execute on function remove_org_member(uuid, uuid) from anon;
grant execute on function remove_org_member(uuid, uuid) to authenticated;

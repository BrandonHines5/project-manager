-- 0105: Stage B2 close-out — org-scope profiles reads (+ the profile-keyed
-- stragglers notification_preferences and ai_plan_applications).
--
-- profiles_self_read's staff arm was a bare is_staff(), so staff of ANY org
-- could read every profile (and profiles_staff_all let them edit every
-- profile). Both now require a SHARED ORG with the target profile via the
-- new shares_org_with() helper — self access is untouched, and the
-- client/trade surfaces never had cross-profile read in the first place.
--
-- Companion code change: the two admin-client user-creation flows now grant
-- organization_members at birth — inviteTeamMember (new staffer joins the
-- acting staffer's org BEFORE the staff-session role promote, which this
-- policy would otherwise reject) and the client invite acceptance (client
-- joins the invite project's org; without it a post-0099 client fails every
-- is_org_member gate, e.g. the 0103 disclaimer read). All existing profiles
-- were backfilled into the Hines org by 0099 — verified zero orphans before
-- this migration. Ad-hoc users created straight in the Supabase dashboard
-- must get a membership row the same way until B5's org-member management UI.

create or replace function public.shares_org_with(p_profile uuid)
returns boolean
language sql
stable security definer
set search_path to 'public'
as $$
  select exists (
    select 1
    from organization_members mine
    join organization_members theirs on theirs.org_id = mine.org_id
    where mine.profile_id = auth.uid()
      and theirs.profile_id = p_profile
  );
$$;

-- Supabase default-grants EXECUTE to anon/authenticated directly (not via
-- PUBLIC), so anon needs its own revoke.
revoke all on function shares_org_with(uuid) from public;
revoke execute on function shares_org_with(uuid) from anon;
grant execute on function shares_org_with(uuid) to authenticated;

-- profiles ------------------------------------------------------------------

drop policy profiles_self_read on profiles;
create policy profiles_self_read on profiles
  for select
  using (id = auth.uid() or (is_staff() and shares_org_with(id)));

drop policy profiles_staff_all on profiles;
create policy profiles_staff_all on profiles
  as permissive for all
  using (is_staff() and shares_org_with(id))
  with check (is_staff() and shares_org_with(id));

-- notification_preferences (self policy untouched) --------------------------

drop policy notif_pref_staff_all on notification_preferences;
create policy notif_pref_staff_all on notification_preferences
  as permissive for all
  using (is_staff() and shares_org_with(profile_id))
  with check (is_staff() and shares_org_with(profile_id));

-- ai_plan_applications (self insert/update policies untouched) ---------------

drop policy ai_plan_applications_staff_read on ai_plan_applications;
create policy ai_plan_applications_staff_read on ai_plan_applications
  for select
  using (is_staff() and shares_org_with(applied_by));

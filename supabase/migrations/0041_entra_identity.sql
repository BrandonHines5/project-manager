-- Central Identity (Microsoft Entra SSO) — PM side.
--
-- Hybrid auth: Hines Homes STAFF sign in with Microsoft Entra and have their
-- PM role resolved from the central directory (the dashboard's team_members +
-- app_roles) at login, mirrored into profiles.role so existing RLS keeps
-- working untouched. Clients (homeowners) and trades keep email+password and
-- are unaffected by everything here.

-- Stable per-tenant Entra object id, so a staff member maps to one profile
-- even if their email later changes. Nullable: password users won't have one.
alter table public.profiles
  add column if not exists entra_user_id text;

create unique index if not exists idx_profiles_entra_user_id
  on public.profiles(entra_user_id)
  where entra_user_id is not null;

-- The post-login directory→role sync runs under the SERVICE ROLE key
-- (server-side, only after the directory confirms the person is active).
-- prevent_role_escalation() blocks role changes for anyone who isn't staff —
-- and the service role's auth.uid() is null, so is_staff() is false and the
-- trigger would block the trusted sync too. Exempt the service role.
--
-- This grants no new capability: the service_role key already bypasses RLS and
-- fully controls the database, so the only thing the trigger was adding for it
-- was an obstacle. Authenticated self-escalation (a signed-in user trying to
-- promote their own row) stays blocked exactly as before.
create or replace function public.prevent_role_escalation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.role is distinct from new.role
     and not public.is_staff()
     and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only staff can change a user role'
      using errcode = '42501';
  end if;
  return new;
end $$;

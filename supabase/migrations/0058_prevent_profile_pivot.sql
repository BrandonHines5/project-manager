-- Prevent self-service pivot via RLS-driving profile columns.
--
-- profiles_self_update (0001) has no column restrictions, and the
-- prevent_role_escalation trigger (0009, service-role exemption added in
-- 0041) guards only `role`. That leaves company_id, financial_access and
-- entra_user_id self-writable: a non-staff user could PATCH their own row
-- via PostgREST and pivot into another company's trade-visibility (RLS
-- policies key project/schedule access off profiles.company_id), flip on
-- financial_access, or claim a staff member's Entra identity.
--
-- Extend the trigger function: non-staff (and non-service-role) sessions
-- may not change any of these columns on their own row. Staff keep managing
-- them via /team, and the SSO callback keeps syncing entra_user_id through
-- the service role (exempt, as in 0041 — the service_role key already
-- bypasses RLS, so the trigger adds nothing for it but an obstacle).
create or replace function public.prevent_role_escalation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_staff()
     and coalesce(auth.role(), '') <> 'service_role' then
    if old.role is distinct from new.role then
      raise exception 'Only staff can change a user role'
        using errcode = '42501';
    end if;
    if old.company_id is distinct from new.company_id
       or old.financial_access is distinct from new.financial_access
       or old.entra_user_id is distinct from new.entra_user_id then
      raise exception 'Only staff can change access-governing profile fields'
        using errcode = '42501';
    end if;
  end if;
  return new;
end $$;

-- 0123: Platform-managed organization columns are service-role-only.
--
-- The 0108 orgs_admin_update policy lets an org's owner/admin UPDATE their
-- own organizations row (name/branding — intended). But the 0122
-- plan/feature_overrides columns — and the earlier lifecycle/billing columns
-- (0116 status/sandbox_expires_at, 0118 stripe_*) — ride the same policy, so
-- a tenant admin could self-upgrade their plan, or flip a lapsed trial back
-- to active, with one hand-rolled PostgREST call. This trigger (the 0009
-- prevent_role_escalation pattern) rejects changes to the platform-managed
-- columns unless the caller is service_role — the operator actions, Stripe
-- webhook, and provisioning RPCs all write with service credentials.
-- (session_user 'postgres' is also exempt so SQL-editor maintenance works.)
--
-- One deliberate carve-out: the sandbox_active → sandbox_expired lazy flip
-- (lib/sandbox.ts resolveOrgLifecycle) runs on the reading MEMBER's session,
-- so exactly that transition stays allowed for non-service callers.

create or replace function public.prevent_org_platform_column_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(auth.role(), '') = 'service_role'
     or session_user = 'postgres' then
    return new;
  end if;
  if new.plan is distinct from old.plan
     or new.feature_overrides is distinct from old.feature_overrides
     or new.stripe_customer_id is distinct from old.stripe_customer_id
     or new.stripe_subscription_id is distinct from old.stripe_subscription_id
     or new.stripe_subscription_status is distinct from old.stripe_subscription_status
     or new.sandbox_expires_at is distinct from old.sandbox_expires_at then
    raise exception 'Plan, feature access, and billing are managed by the platform'
      using errcode = '42501';
  end if;
  if new.status is distinct from old.status
     and not (old.status = 'sandbox_active' and new.status = 'sandbox_expired') then
    raise exception 'Organization status is managed by the platform'
      using errcode = '42501';
  end if;
  return new;
end $$;

grant execute on function public.prevent_org_platform_column_change() to anon, authenticated;

drop trigger if exists trg_prevent_org_platform_column_change on public.organizations;
create trigger trg_prevent_org_platform_column_change
  before update on public.organizations
  for each row execute function public.prevent_org_platform_column_change();

-- Per-user master switch for all site notifications.
--
-- When `notifications_enabled` is false the user receives nothing from the
-- site: no in-app bell entries and no emails. Enforcement is centralized:
--   - A BEFORE INSERT trigger on `notifications` silently drops rows whose
--     recipient is muted. That covers BOTH the in-app bell AND the daily
--     digest (the digest cron emails based on those rows), across every
--     insert path (server actions + the client_decide_decision RPC).
--   - The direct per-event email paths (immediate assignment email, approved-
--     decision staff email, client decision email) additionally check the flag
--     in application code, since those send without writing a notifications row.

alter table public.profiles
  add column if not exists notifications_enabled boolean not null default true;

create or replace function public.skip_notification_if_muted()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (
    select 1 from public.profiles
    where id = new.recipient_id
      and notifications_enabled = false
  ) then
    -- Returning NULL from a BEFORE INSERT row trigger skips the insert.
    return null;
  end if;
  return new;
end;
$$;

-- Trigger functions are invoked by the trigger machinery, not via the REST
-- RPC surface, so pull EXECUTE from the API roles to keep it off the linter's
-- "SECURITY DEFINER callable by anon/authenticated" list.
revoke execute on function public.skip_notification_if_muted() from public, anon, authenticated;

drop trigger if exists trg_skip_muted_notifications on public.notifications;
create trigger trg_skip_muted_notifications
  before insert on public.notifications
  for each row execute function public.skip_notification_if_muted();

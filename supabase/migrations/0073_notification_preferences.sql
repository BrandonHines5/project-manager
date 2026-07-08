-- Notification Settings (item 3): let staff control who and what types of
-- notifications go out — to team members, to sub/vendor companies, and to
-- clients — and let each user self-manage their own.
--
-- Model: a sparse preference table keyed by (owner, category, channel). An
-- OWNER is either a profile (a team member or a client) or a company (a
-- sub/vendor). CATEGORY groups the ~15 notification event types into a small,
-- readable set. CHANNEL is in_app | email | sms. Absence of a row means the
-- channel is ENABLED — so before anyone sets a preference, behavior is exactly
-- as it is today. Only an explicit `enabled = false` row suppresses a channel.
--
-- Categories:
--   assignments      schedule/to-do assignments (schedule_assignment, decision_followup)
--   bids_pos         bid & PO responses (bid_submitted/declined, po_approved/declined)
--   comments         comment threads + inbound messages (comment_posted, inbound_*)
--   client_decisions client approval/decline of change orders & selections
--   reminders        bid reminders, insurance-expiry reminders

create table if not exists public.notification_preferences (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid references public.profiles(id) on delete cascade,
  company_id uuid references public.companies(id) on delete cascade,
  category text not null check (
    category in ('assignments','bids_pos','comments','client_decisions','reminders')
  ),
  channel text not null check (channel in ('in_app','email','sms')),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Exactly one owner: a profile OR a company, never both/neither.
  constraint notif_pref_one_owner check (
    (profile_id is not null and company_id is null) or
    (profile_id is null and company_id is not null)
  )
);

create unique index if not exists uq_notif_pref_profile
  on public.notification_preferences (profile_id, category, channel)
  where profile_id is not null;
create unique index if not exists uq_notif_pref_company
  on public.notification_preferences (company_id, category, channel)
  where company_id is not null;

-- touch updated_at on write (reuse the app-wide helper if present).
drop trigger if exists trg_notif_pref_touch on public.notification_preferences;
create trigger trg_notif_pref_touch
  before update on public.notification_preferences
  for each row execute function public.touch_updated_at();

alter table public.notification_preferences enable row level security;

-- A user manages their OWN preferences (any role). Staff manage everyone's
-- profile preferences plus all company preferences.
drop policy if exists notif_pref_self on public.notification_preferences;
create policy notif_pref_self on public.notification_preferences
  for all
  using (profile_id = auth.uid())
  with check (profile_id = auth.uid());

drop policy if exists notif_pref_staff_all on public.notification_preferences;
create policy notif_pref_staff_all on public.notification_preferences
  for all
  using (public.is_staff())
  with check (public.is_staff());

-- Extend the central in-app gate: on top of the master mute switch, drop an
-- in-app notification row when its recipient has explicitly disabled the
-- matching category's in_app channel. Backward-compatible: with no preference
-- rows this behaves exactly like the 0036 version.
create or replace function public.skip_notification_if_muted()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_category text;
begin
  -- Master switch (0036).
  if exists (
    select 1 from public.profiles
    where id = new.recipient_id
      and notifications_enabled = false
  ) then
    return null;
  end if;

  -- Per-category in-app preference (0073). `inbound_${kind}` types are built
  -- dynamically, so match the family with LIKE.
  v_category := case
    when new.type in ('schedule_assignment','decision_followup') then 'assignments'
    when new.type in ('bid_submitted','bid_declined','po_approved','po_declined') then 'bids_pos'
    when new.type = 'comment_posted' or new.type like 'inbound_%' then 'comments'
    else null
  end;

  if v_category is not null and exists (
    select 1 from public.notification_preferences np
    where np.profile_id = new.recipient_id
      and np.category = v_category
      and np.channel = 'in_app'
      and np.enabled = false
  ) then
    return null;
  end if;

  return new;
end;
$$;

revoke execute on function public.skip_notification_if_muted() from public, anon, authenticated;

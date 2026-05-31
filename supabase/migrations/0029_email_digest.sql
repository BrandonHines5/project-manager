-- Email digest preference. Right now every schedule assignment, decision
-- approval, and follow-up creation fires a per-event email. For a staff
-- member assigned to 30 active items in a busy week, that's a wall of
-- alerts. Let them opt into a daily roll-up instead.
--
-- pref values:
--   - immediate (default): existing behaviour. One email per event.
--   - daily: skip the per-event email; a /api/cron/email-digest run
--     batches everything since last_digest_at into one email.
--   - off: never email this profile. In-app bell still works.
--
-- A new notifications.email_sent_at column tracks which rows the digest
-- has already covered so re-runs don't double-fire. The immediate path
-- updates the same column when it sends, so toggling digest mode
-- mid-day doesn't replay rows the user already saw.

do $$ begin
  create type email_digest_pref as enum ('immediate', 'daily', 'off');
exception when duplicate_object then null; end $$;

alter table public.profiles
  add column if not exists email_digest_pref email_digest_pref not null default 'immediate',
  add column if not exists last_digest_at timestamptz;

alter table public.notifications
  add column if not exists email_sent_at timestamptz;
create index if not exists idx_notifications_email_pending
  on public.notifications(recipient_id, created_at)
  where email_sent_at is null;

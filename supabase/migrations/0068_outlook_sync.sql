-- Delta-sync cursors for the Outlook mail sync cron (Phase 4 of the
-- Communications hub). One row per (mailbox, folder); delta_link stores
-- wherever the last run stopped — either a nextLink (mid-sync) or a
-- deltaLink (caught up), both resume correctly.

create table if not exists public.outlook_sync_state (
  mailbox text not null,
  folder text not null, -- 'inbox' | 'sentitems'
  delta_link text,
  updated_at timestamptz not null default now(),
  primary key (mailbox, folder)
);

alter table public.outlook_sync_state enable row level security;

-- Written only by the service-role cron; staff can read for debugging.
drop policy if exists oss_staff_read on public.outlook_sync_state;
create policy oss_staff_read on public.outlook_sync_state
  for select using (public.is_staff());

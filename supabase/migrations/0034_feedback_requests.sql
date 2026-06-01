-- Feedback & Requests
-- An in-app channel for any signed-in user (staff, trade, or client) to send
-- site-update requests to the staff "admin". Submitters can track the status
-- and any reply on their own requests; staff triage every request (change
-- status / notes) and may delete. RLS is the source of truth — the UI just
-- mirrors what these policies allow.

create table if not exists public.feedback_requests (
  id                 uuid primary key default gen_random_uuid(),
  -- Who filed it. We keep both the profile id (for reliable "my requests"
  -- lookups that survive a name/email change) and a name/email snapshot so
  -- the row is still legible if the profile is later deleted.
  submitted_by_id    uuid references public.profiles(id) on delete set null,
  submitted_by       text not null,
  submitted_by_email text,
  request_type       text not null default 'Feature Request'
    check (request_type in ('Feature Request', 'Bug Report', 'Update Request', 'Question')),
  title              text not null,
  description        text,
  status             text not null default 'New'
    check (status in ('New', 'In Review', 'In Progress', 'Complete', 'Declined')),
  admin_notes        text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists idx_feedback_status on public.feedback_requests(status);
create index if not exists idx_feedback_submitter
  on public.feedback_requests(submitted_by_id, created_at desc);
create index if not exists idx_feedback_created on public.feedback_requests(created_at desc);

drop trigger if exists trg_feedback_updated_at on public.feedback_requests;
create trigger trg_feedback_updated_at before update on public.feedback_requests
  for each row execute function public.touch_updated_at();

alter table public.feedback_requests enable row level security;

-- Staff (the admin role in this app) can read every request and triage it
-- (status / notes) or delete it. Note: NOT `for all` — INSERT is governed by
-- feedback_insert_self below so even staff-filed requests are self-attributed
-- (submitted_by_id = the caller), keeping the audit trail honest.
drop policy if exists feedback_staff_all on public.feedback_requests;
drop policy if exists feedback_staff_read on public.feedback_requests;
drop policy if exists feedback_staff_update on public.feedback_requests;
drop policy if exists feedback_staff_delete on public.feedback_requests;
create policy feedback_staff_read on public.feedback_requests
  for select using (public.is_staff());
create policy feedback_staff_update on public.feedback_requests
  for update using (public.is_staff()) with check (public.is_staff());
create policy feedback_staff_delete on public.feedback_requests
  for delete using (public.is_staff());

-- Any signed-in user may file a request, but only as themselves — the snapshot
-- id must match the caller so a row can't be attributed to someone else. This
-- is the ONLY insert path, for staff and non-staff alike.
drop policy if exists feedback_insert_self on public.feedback_requests;
create policy feedback_insert_self on public.feedback_requests
  for insert to authenticated
  with check (submitted_by_id = (select auth.uid()));

-- Submitters can read the status / admin reply on their own requests. (Staff
-- already read everything via feedback_staff_read.) Note there is deliberately
-- no client/trade UPDATE or DELETE policy — only staff can triage.
drop policy if exists feedback_read_own on public.feedback_requests;
create policy feedback_read_own on public.feedback_requests
  for select to authenticated
  using (submitted_by_id = (select auth.uid()));

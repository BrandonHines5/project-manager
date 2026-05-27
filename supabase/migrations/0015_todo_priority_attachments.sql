-- Schedule round 2: to-do priority, to-do attachments, and storage RLS for
-- trade users on both schedule attachments and any schedule-item-linked file.
--
-- 1. New enum `todo_priority` (low / medium / high) + nullable column
--    schedule_items.priority. Nullable so existing rows aren't forced into a
--    default and so the UI can render "no priority set" distinctly.
-- 2. New table `schedule_item_attachments` (mirrors daily_log_attachments /
--    decision_attachments). Used by both work items and to-dos; the
--    `schedule_item_id` FK is the discriminator.
-- 3. Storage RLS: trades can READ objects in `project-files` that are
--    referenced by a schedule_item_attachments row whose parent item the
--    trade is assigned to (directly or via company). Staff already covered.

-- 1. Priority enum + column
do $$ begin
  create type todo_priority as enum ('low', 'medium', 'high');
exception when duplicate_object then null; end $$;

alter table public.schedule_items
  add column if not exists priority todo_priority;

create index if not exists idx_si_priority
  on public.schedule_items(project_id, priority)
  where priority is not null;

-- 2. Attachments table
create table if not exists public.schedule_item_attachments (
  id uuid primary key default gen_random_uuid(),
  schedule_item_id uuid not null references public.schedule_items(id) on delete cascade,
  storage_bucket text not null default 'project-files',
  storage_path text not null,
  file_name text not null,
  file_type text,
  file_size bigint,
  caption text,
  position int not null default 0,
  uploaded_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists idx_sia_item on public.schedule_item_attachments(schedule_item_id);

alter table public.schedule_item_attachments enable row level security;

-- Staff: full access.
drop policy if exists sia_staff_all on public.schedule_item_attachments;
create policy sia_staff_all on public.schedule_item_attachments
  for all using (public.is_staff()) with check (public.is_staff());

-- Trade: read attachments on schedule items they (or their company) are
-- assigned to. Mirrors `schedule_items_trade_read`.
drop policy if exists sia_trade_read on public.schedule_item_attachments;
create policy sia_trade_read on public.schedule_item_attachments
  for select using (
    public.current_role_name() = 'trade'
    and exists (
      select 1
      from public.schedule_assignments sa
      left join public.profiles p on p.id = auth.uid()
      where sa.schedule_item_id = schedule_item_attachments.schedule_item_id
        and (sa.profile_id = auth.uid() or sa.company_id = p.company_id)
    )
  );

-- 3. Extend storage RLS on `project-files` to cover schedule_item_attachments
-- for clients (members of the project) AND trades (assigned to the item).
-- We rewrite the existing client read policy and add a trade read policy.
drop policy if exists project_files_client_read on storage.objects;
create policy project_files_client_read on storage.objects
  for select using (
    bucket_id = 'project-files'
    and (
      exists (
        select 1
        from public.daily_log_attachments a
        join public.daily_logs dl on dl.id = a.daily_log_id
        where a.storage_path = storage.objects.name
          and a.storage_bucket = storage.objects.bucket_id
          and public.current_role_name() = 'client'
          and dl.visibility = 'client'
          and public.is_member_of_project(dl.project_id)
      )
      or exists (
        select 1
        from public.decision_attachments da
        join public.decisions d on d.id = da.decision_id
        where da.storage_path = storage.objects.name
          and da.storage_bucket = storage.objects.bucket_id
          and public.current_role_name() = 'client'
          and public.is_member_of_project(d.project_id)
          and d.status in ('pending_client', 'approved', 'rejected')
      )
      or exists (
        select 1
        from public.project_files pf
        where pf.storage_path = storage.objects.name
          and pf.storage_bucket = storage.objects.bucket_id
          and public.current_role_name() = 'client'
          and public.is_member_of_project(pf.project_id)
      )
    )
  );

drop policy if exists project_files_trade_read on storage.objects;
create policy project_files_trade_read on storage.objects
  for select using (
    bucket_id = 'project-files'
    and public.current_role_name() = 'trade'
    and exists (
      select 1
      from public.schedule_item_attachments sia
      join public.schedule_assignments sa on sa.schedule_item_id = sia.schedule_item_id
      left join public.profiles p on p.id = auth.uid()
      where sia.storage_path = storage.objects.name
        and sia.storage_bucket = storage.objects.bucket_id
        and (sa.profile_id = auth.uid() or sa.company_id = p.company_id)
    )
  );

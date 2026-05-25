do $$ begin
  create type decision_kind as enum ('change_order', 'selection');
exception when duplicate_object then null; end $$;

do $$ begin
  create type decision_status as enum ('draft', 'pending_client', 'approved', 'rejected');
exception when duplicate_object then null; end $$;

create table if not exists public.decisions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  number int not null,
  kind decision_kind not null,
  title text not null,
  description text,
  cost_delta numeric(14,2),
  status decision_status not null default 'draft',
  approved_at timestamptz,
  approved_by_client_id uuid references public.profiles(id) on delete set null,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, number)
);
create index if not exists idx_decisions_project on public.decisions(project_id, created_at desc);
create index if not exists idx_decisions_status on public.decisions(project_id, status);

drop trigger if exists trg_decisions_updated_at on public.decisions;
create trigger trg_decisions_updated_at before update on public.decisions
  for each row execute function public.touch_updated_at();

create table if not exists public.decision_comments (
  id uuid primary key default gen_random_uuid(),
  decision_id uuid not null references public.decisions(id) on delete cascade,
  author_id uuid references public.profiles(id) on delete set null,
  body text not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_dc_decision on public.decision_comments(decision_id, created_at);

create table if not exists public.decision_attachments (
  id uuid primary key default gen_random_uuid(),
  decision_id uuid not null references public.decisions(id) on delete cascade,
  storage_bucket text not null default 'project-files',
  storage_path text not null,
  file_name text not null,
  file_type text,
  file_size bigint,
  caption text,
  position int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists idx_da_decision on public.decision_attachments(decision_id);

create table if not exists public.decision_followup_templates (
  id uuid primary key default gen_random_uuid(),
  decision_id uuid not null references public.decisions(id) on delete cascade,
  title text not null,
  assignee_profile_id uuid references public.profiles(id) on delete set null,
  assignee_company_id uuid references public.companies(id) on delete set null,
  due_offset_days int not null default 7,
  notes text,
  position int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists idx_dft_decision on public.decision_followup_templates(decision_id);

alter table public.schedule_items
  add column if not exists source_decision_id uuid references public.decisions(id) on delete set null;
create index if not exists idx_si_source_decision on public.schedule_items(source_decision_id);

create or replace function public.next_decision_number(p_project uuid)
returns int
language sql
stable
security definer
set search_path = public
as $fn$
  select coalesce(max(number), 0) + 1 from public.decisions where project_id = p_project;
$fn$;
revoke execute on function public.next_decision_number(uuid) from anon, authenticated, public;

alter table public.decisions                    enable row level security;
alter table public.decision_comments            enable row level security;
alter table public.decision_attachments         enable row level security;
alter table public.decision_followup_templates  enable row level security;

drop policy if exists decisions_staff_all on public.decisions;
create policy decisions_staff_all on public.decisions
  for all using (public.is_staff()) with check (public.is_staff());

drop policy if exists decisions_client_read on public.decisions;
create policy decisions_client_read on public.decisions
  for select using (
    public.current_role_name() = 'client'
    and public.is_member_of_project(project_id)
    and status in ('pending_client', 'approved', 'rejected')
  );

drop policy if exists dc_staff_all on public.decision_comments;
create policy dc_staff_all on public.decision_comments
  for all using (public.is_staff()) with check (public.is_staff());

drop policy if exists dc_member_read on public.decision_comments;
create policy dc_member_read on public.decision_comments
  for select using (
    exists (
      select 1 from public.decisions d
      where d.id = decision_comments.decision_id
        and public.current_role_name() = 'client'
        and public.is_member_of_project(d.project_id)
        and d.status in ('pending_client', 'approved', 'rejected')
    )
  );

drop policy if exists dc_client_insert on public.decision_comments;
create policy dc_client_insert on public.decision_comments
  for insert with check (
    author_id = auth.uid()
    and exists (
      select 1 from public.decisions d
      where d.id = decision_comments.decision_id
        and public.current_role_name() = 'client'
        and public.is_member_of_project(d.project_id)
        and d.status in ('pending_client', 'approved', 'rejected')
    )
  );

drop policy if exists da_staff_all on public.decision_attachments;
create policy da_staff_all on public.decision_attachments
  for all using (public.is_staff()) with check (public.is_staff());

drop policy if exists da_client_read on public.decision_attachments;
create policy da_client_read on public.decision_attachments
  for select using (
    exists (
      select 1 from public.decisions d
      where d.id = decision_attachments.decision_id
        and public.current_role_name() = 'client'
        and public.is_member_of_project(d.project_id)
        and d.status in ('pending_client', 'approved', 'rejected')
    )
  );

drop policy if exists dft_staff_all on public.decision_followup_templates;
create policy dft_staff_all on public.decision_followup_templates
  for all using (public.is_staff()) with check (public.is_staff());

-- Extend storage RLS for decision attachments (clients can read via signed URLs)
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
    )
  );

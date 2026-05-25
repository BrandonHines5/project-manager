do $$ begin
  create type file_category as enum ('house_plans', 'plot_plan', 'permit', 'contract', 'other');
exception when duplicate_object then null; end $$;

create table if not exists public.project_files (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  category file_category not null default 'other',
  title text not null,
  description text,
  storage_bucket text not null default 'project-files',
  storage_path text not null,
  file_name text not null,
  file_type text,
  file_size bigint,
  uploaded_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists idx_pf_project on public.project_files(project_id, created_at desc);
create index if not exists idx_pf_category on public.project_files(project_id, category);

alter table public.project_files enable row level security;

drop policy if exists pf_staff_all on public.project_files;
create policy pf_staff_all on public.project_files
  for all using (public.is_staff()) with check (public.is_staff());

drop policy if exists pf_client_read on public.project_files;
create policy pf_client_read on public.project_files
  for select using (
    public.current_role_name() = 'client'
    and public.is_member_of_project(project_id)
  );

-- Extend storage RLS to cover project_files
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

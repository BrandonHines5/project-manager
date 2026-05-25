do $$ begin
  create type daily_log_visibility as enum ('internal', 'client');
exception when duplicate_object then null; end $$;

create table if not exists public.daily_logs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  log_date date not null default current_date,
  visibility daily_log_visibility not null default 'internal',
  notes text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_dl_project on public.daily_logs(project_id, log_date desc);
create index if not exists idx_dl_visibility on public.daily_logs(project_id, visibility);

drop trigger if exists trg_dl_updated_at on public.daily_logs;
create trigger trg_dl_updated_at before update on public.daily_logs
  for each row execute function public.touch_updated_at();

create table if not exists public.daily_log_subs_on_site (
  daily_log_id uuid not null references public.daily_logs(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  notes text,
  primary key (daily_log_id, company_id)
);
create index if not exists idx_dlsos_company on public.daily_log_subs_on_site(company_id);

create table if not exists public.daily_log_attachments (
  id uuid primary key default gen_random_uuid(),
  daily_log_id uuid not null references public.daily_logs(id) on delete cascade,
  storage_bucket text not null default 'project-files',
  storage_path text not null,
  file_name text not null,
  file_type text,
  file_size bigint,
  caption text,
  position int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists idx_dla_log on public.daily_log_attachments(daily_log_id);

alter table public.daily_logs              enable row level security;
alter table public.daily_log_subs_on_site  enable row level security;
alter table public.daily_log_attachments   enable row level security;

drop policy if exists daily_logs_staff_all on public.daily_logs;
create policy daily_logs_staff_all on public.daily_logs
  for all using (public.is_staff()) with check (public.is_staff());

drop policy if exists daily_logs_client_read on public.daily_logs;
create policy daily_logs_client_read on public.daily_logs
  for select using (
    public.current_role_name() = 'client'
    and visibility = 'client'
    and public.is_member_of_project(project_id)
  );

drop policy if exists dlsos_staff_all on public.daily_log_subs_on_site;
create policy dlsos_staff_all on public.daily_log_subs_on_site
  for all using (public.is_staff()) with check (public.is_staff());

drop policy if exists dlsos_client_read on public.daily_log_subs_on_site;
create policy dlsos_client_read on public.daily_log_subs_on_site
  for select using (
    exists (
      select 1 from public.daily_logs dl
      where dl.id = daily_log_subs_on_site.daily_log_id
        and public.current_role_name() = 'client'
        and dl.visibility = 'client'
        and public.is_member_of_project(dl.project_id)
    )
  );

drop policy if exists dla_staff_all on public.daily_log_attachments;
create policy dla_staff_all on public.daily_log_attachments
  for all using (public.is_staff()) with check (public.is_staff());

drop policy if exists dla_client_read on public.daily_log_attachments;
create policy dla_client_read on public.daily_log_attachments
  for select using (
    exists (
      select 1 from public.daily_logs dl
      where dl.id = daily_log_attachments.daily_log_id
        and public.current_role_name() = 'client'
        and dl.visibility = 'client'
        and public.is_member_of_project(dl.project_id)
    )
  );

-- Storage: private bucket for project files (idempotent)
insert into storage.buckets (id, name, public)
  values ('project-files', 'project-files', false)
  on conflict (id) do nothing;

drop policy if exists project_files_staff_all on storage.objects;
create policy project_files_staff_all on storage.objects
  for all using (bucket_id = 'project-files' and public.is_staff())
  with check (bucket_id = 'project-files' and public.is_staff());

drop policy if exists project_files_client_read on storage.objects;
create policy project_files_client_read on storage.objects
  for select using (
    bucket_id = 'project-files'
    and exists (
      select 1
      from public.daily_log_attachments a
      join public.daily_logs dl on dl.id = a.daily_log_id
      where a.storage_path = storage.objects.name
        and a.storage_bucket = storage.objects.bucket_id
        and public.current_role_name() = 'client'
        and dl.visibility = 'client'
        and public.is_member_of_project(dl.project_id)
    )
  );

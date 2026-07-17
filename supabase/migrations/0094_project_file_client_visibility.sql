-- =====================================================================
-- 0094 — Per-file client visibility on project_files
-- =====================================================================
-- Staff choose, file by file, whether the client sees it. Two policies
-- move in LOCKSTEP: the table read (pf_client_read) and the storage-object
-- read (project_files_client_read) — tightening only one would either leak
-- objects for hidden rows or strand visible rows without signable objects.
--
-- Rollout: existing rows backfill to TRUE (clients see everything today —
-- hiding it all mid-conversation would be a silent behavior change) and the
-- column DEFAULTS to true, so nothing changes until staff unchecks a file.

alter table public.project_files
  add column if not exists client_visible boolean not null default true;

comment on column public.project_files.client_visible is
  'Whether the client portal shows this file. Staff-only toggle; enforced '
  'by pf_client_read AND the project_files_client_read storage policy.';

-- ----- table read ------------------------------------------------------
drop policy if exists pf_client_read on public.project_files;
create policy pf_client_read on public.project_files
  for select using (
    public.current_role_name() = 'client'
    and public.is_member_of_project(project_id)
    and client_visible = true
  );

-- ----- storage-object read --------------------------------------------
-- Recreate of the 0015 policy: the daily-log and decision branches are
-- copied VERBATIM (dropping them would break client photo + decision-
-- attachment viewing app-wide); only the project_files branch gains the
-- client_visible check.
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
          and pf.client_visible = true
      )
    )
  );

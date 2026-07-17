-- =====================================================================
-- 0096 — Clients read only the CURRENT revision of a project file
-- =====================================================================
-- Revision history is staff-only in the UI (getFileVersions requires
-- staff), but the 0094 policies still let a client SELECT older revisions
-- directly through PostgREST — and hiding the current head via
-- client_visible left still-visible history readable. Add is_current to
-- both lockstep policies (table read + storage-object read). The daily-log
-- and decision branches of the storage policy are copied VERBATIM again.

-- ----- table read ------------------------------------------------------
drop policy if exists pf_client_read on public.project_files;
create policy pf_client_read on public.project_files
  for select using (
    public.current_role_name() = 'client'
    and public.is_member_of_project(project_id)
    and client_visible = true
    and is_current = true
  );

-- ----- storage-object read --------------------------------------------
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
          and pf.is_current = true
      )
    )
  );

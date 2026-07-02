-- Initiate Utilities: source the Job dropdown from the CRM.
--
-- Utilities are initiated at the very start of a job — usually before the job
-- is being managed in this app — so most active CRM jobs (project_status
-- 'In Work' / 'Upcoming') have no local projects row yet. Let a utility
-- request reference the CRM job directly:
--   * project_id becomes optional (still linked when a local project with the
--     same project_number exists),
--   * crm_project_id holds the CRM projects.id for CRM-sourced jobs,
--   * job_label snapshots a display label ("25-13 — 607 Corondelet Lane") at
--     save time so request cards render without a live CRM join.

alter table public.utility_requests
  alter column project_id drop not null;

alter table public.utility_requests
  add column if not exists crm_project_id uuid,
  add column if not exists job_label text;

-- Every request must reference SOME job — local, CRM, or both.
alter table public.utility_requests
  drop constraint if exists utility_requests_job_link;
alter table public.utility_requests
  add constraint utility_requests_job_link
  check (project_id is not null or crm_project_id is not null);

-- Backfill labels for existing rows from their local project.
update public.utility_requests ur
set job_label = p.project_number || ' — ' || p.name
from public.projects p
where ur.project_id = p.id
  and ur.job_label is null;

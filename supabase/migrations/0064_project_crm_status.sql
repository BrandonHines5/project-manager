-- Mirror the Hines Homes CRM's project_status (and official job name) onto local
-- projects so the job list shows exactly what the CRM/dashboard shows.
--
-- The local `status` enum stays the driver for internal logic (warranty page,
-- portfolio health); crm_status is the verbatim CRM word used for display. A
-- manual "Sync from CRM" action (app/actions/crm-sync.ts) fills both, matched
-- by project_number.
alter table public.projects
  add column if not exists crm_status text,
  add column if not exists crm_status_synced_at timestamptz;

comment on column public.projects.crm_status is
  'Verbatim project_status pulled from the HH-CRM projects table (In Work, Upcoming, Inventory, Paused, Complete, Warranty, Cancelled). Display-only; the status enum drives PM logic. Synced by app/actions/crm-sync.ts.';

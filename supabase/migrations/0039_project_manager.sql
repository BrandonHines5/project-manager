-- Project manager, mirrored from the Hines Homes Dashboard.
--
-- The dashboard is the source of truth for who's managing each job. PM pulls
-- the name in when a project is created from the dashboard picker, and the
-- per-project "Sync from dashboard" button refreshes it (and the dashboard
-- link) on demand. Stored as free text — it's a display label sourced from
-- the dashboard, not a PM-app profile reference.

alter table public.projects
  add column if not exists project_manager text;

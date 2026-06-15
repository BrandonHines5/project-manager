-- Archive support for plans & documents. Old plans, contracts, permits, etc.
-- shouldn't clutter the active "Plans & documents" list once a project moves
-- on, but they must stay accessible (and downloadable by clients who grabbed
-- a link earlier). A soft "archived_at" timestamp keeps the row + storage
-- object intact; the UI simply moves archived files into a separate "Archived"
-- folder and hides them from the active list and the project gallery.
--
-- Nullable + no default => existing rows stay active (archived_at IS NULL).
-- We don't touch is_current: an archived file is still the head of its
-- revision chain, just filed away.

alter table public.project_files
  add column if not exists archived_at timestamptz;

-- Active head lookups (the common case) skip archived rows. Mirrors the
-- existing idx_pf_current but scoped to non-archived heads so the plans
-- list query stays a simple index hit.
create index if not exists idx_pf_active_current
  on public.project_files(project_id, category)
  where is_current = true and archived_at is null;

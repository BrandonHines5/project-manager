-- Project labels.
--
-- Free-form tags on a project, surfaced in the project-list sidebar as an extra
-- filter alongside the status filters (Open / Active / Warranty / Closed / All).
-- The first use is a "Test" label so staff can separate leftover test jobs from
-- the real homes now being tracked, but the column is intentionally generic so
-- future labels (e.g. "Spec", "Commercial") need no schema change.
--
-- Stored as a text[] rather than a junction table: labels are a short,
-- per-project list with no attributes of their own, and the sidebar already
-- loads every project and filters in memory, so there's nothing to join.

alter table public.projects
  add column if not exists labels text[] not null default '{}';

comment on column public.projects.labels is
  'Free-form labels/tags on the project (e.g. "Test"). Surfaced as filters in the project-list sidebar.';

-- NOTE: the one-time tagging of the existing "Open" jobs as 'Test' is applied
-- as a separate data update against the live database (see the PR description),
-- not here — replaying this migration on a fresh environment must not assume a
-- particular set of rows are test data.

-- Drop the project-level target_completion_date column.
--
-- Target completion is no longer captured on projects. The schedule's
-- Substantial Completion milestone (and the health banner derived from it)
-- is the source of truth for a job's projected finish, so a separate
-- project-level target date was redundant and drifted out of sync.
--
-- The New Project form, Edit Project dialog, and Projects list column that
-- surfaced this field have all been removed, leaving the column dead weight.
-- The project_history audit trigger diffs projects via to_jsonb(new/old)
-- generically, so removing the column needs no trigger change.

alter table public.projects
  drop column if exists target_completion_date;

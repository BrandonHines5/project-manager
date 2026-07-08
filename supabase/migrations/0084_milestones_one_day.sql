-- Job Start / Substantial Completion milestones are single-day markers.
--
-- The app now enforces a 1-day duration on these milestones on every write
-- (create, edit, drag, template copy). This backfill collapses any EXISTING
-- milestone that currently spans multiple days, keeping the semantically
-- meaningful edge so the schedule-health math is unchanged:
--   - Job Start keeps its START date (end := start)
--   - Substantial Completion keeps its END date (start := end)
-- Baseline dates collapse the same way, because health/variance reads Job
-- Start's baseline START and Substantial Completion's baseline END.
--
-- The protect_schedule_milestones trigger allows date updates (it only blocks
-- changing the marker/kind or deleting the row), so these updates go through.

-- Job Start: end := start
update public.schedule_items
   set end_date = start_date,
       duration_days = 1
 where milestone = 'job_start'
   and start_date is not null
   and (end_date is distinct from start_date or duration_days is distinct from 1);

update public.schedule_items
   set baseline_end_date = baseline_start_date
 where milestone = 'job_start'
   and baseline_start_date is not null
   and baseline_end_date is distinct from baseline_start_date;

-- Substantial Completion: start := end
update public.schedule_items
   set start_date = end_date,
       duration_days = 1
 where milestone = 'substantial_completion'
   and end_date is not null
   and (start_date is distinct from end_date or duration_days is distinct from 1);

update public.schedule_items
   set baseline_start_date = baseline_end_date
 where milestone = 'substantial_completion'
   and baseline_end_date is not null
   and baseline_start_date is distinct from baseline_end_date;

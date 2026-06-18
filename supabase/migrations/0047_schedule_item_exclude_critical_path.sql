-- Let a schedule item opt out of the critical-path calculation.
--
-- Not everything on the schedule is real on-site work. A "completion target"
-- milestone, a soft client-facing date, or a placeholder may be added to the
-- timeline purely for visibility — but it shouldn't drive (or appear on) the
-- critical path, because no crew is actually doing it. When this flag is set
-- the CPM engine (lib/schedule/scheduling.ts) drops the item from its work-item
-- set, so it never shows up as critical and never lengthens the project finish.

alter table public.schedule_items
  add column if not exists exclude_from_critical_path boolean not null default false;

-- Anchor a to-do's due_date to a parent work item's start or end date,
-- plus a signed day offset. When the parent moves, anchored children's
-- due_dates are recomputed via the cascade in app/actions/schedule.ts.
--
-- `due_date` itself stays canonical (denormalized) so the gantt / list /
-- calendar / reports keep reading one column. The anchor fields are just
-- the recipe used to refresh it.

do $$ begin
  create type schedule_parent_anchor as enum ('start', 'end');
exception when duplicate_object then null; end $$;

alter table public.schedule_items
  add column if not exists parent_anchor schedule_parent_anchor,
  add column if not exists parent_offset_days int;

-- Either both anchor fields are set, or neither. Prevents half-configured
-- to-dos where anchor is set but offset isn't (or vice-versa).
alter table public.schedule_items
  drop constraint if exists schedule_items_parent_anchor_pair_chk;
alter table public.schedule_items
  add constraint schedule_items_parent_anchor_pair_chk
  check (
    (parent_anchor is null and parent_offset_days is null)
    or (parent_anchor is not null and parent_offset_days is not null)
  );

-- The anchor only makes sense for a to-do that has a parent. Block staff
-- from sneaking it onto a work item or an unparented to-do.
alter table public.schedule_items
  drop constraint if exists schedule_items_parent_anchor_kind_chk;
alter table public.schedule_items
  add constraint schedule_items_parent_anchor_kind_chk
  check (
    parent_anchor is null
    or (kind = 'todo' and parent_id is not null)
  );

-- Partial index — the cascade only ever queries the anchored subset.
create index if not exists idx_si_parent_anchor
  on public.schedule_items(parent_id)
  where parent_anchor is not null;

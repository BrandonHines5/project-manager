-- Schedule baseline + protected Job Start / Substantial Completion milestones.
--
-- The overall job duration is tracked between two protected work items per
-- project: 'Job Start' (beginning of construction) and 'Substantial
-- Completion' (end of construction). They can be moved, completed, and wired
-- into predecessors like any work item, but they can never be deleted (a
-- BEFORE DELETE trigger blocks it except during project cascade deletes).
--
-- "Setting the baseline" locks the current plan: it copies every work item's
-- start/end into baseline_start_date/baseline_end_date (columns that have
-- existed since 0001 but were never populated) and stamps
-- projects.baseline_set_at. App-layer rules key off that stamp:
--   - work items can't be marked complete until the baseline is set
--   - post-baseline date moves require a reason (logged to schedule_delays)

-- ---------------------------------------------------------------------------
-- Milestone marker on schedule_items
-- ---------------------------------------------------------------------------
do $$ begin
  create type public.schedule_milestone as enum ('job_start', 'substantial_completion');
exception
  when duplicate_object then null;
end $$;

alter table public.schedule_items
  add column if not exists milestone public.schedule_milestone;

comment on column public.schedule_items.milestone is
  'Protected per-project milestone marker: job_start / substantial_completion. Rows with a marker cannot be deleted and define the tracked job duration.';

-- One of each milestone per project, at most.
create unique index if not exists uq_si_project_milestone
  on public.schedule_items(project_id, milestone)
  where milestone is not null;

-- ---------------------------------------------------------------------------
-- Baseline stamp on projects
-- ---------------------------------------------------------------------------
alter table public.projects
  add column if not exists baseline_set_at timestamptz,
  add column if not exists baseline_set_by uuid references public.profiles(id) on delete set null;

comment on column public.projects.baseline_set_at is
  'When the schedule baseline was (last) locked in. Null = no baseline yet: work items cannot be completed and date moves need no reason.';

-- ---------------------------------------------------------------------------
-- Delete/alter protection for milestone rows
-- ---------------------------------------------------------------------------
-- The EXISTS check lets FK cascade deletes through: when a project is
-- deleted, its row is gone by the time the cascade reaches schedule_items,
-- so the milestone rows delete cleanly with the rest of the project.
create or replace function public.protect_schedule_milestones()
returns trigger language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if old.milestone is not null
       and exists (select 1 from public.projects p where p.id = old.project_id) then
      raise exception '"%" is a protected schedule milestone and cannot be deleted.', old.title;
    end if;
    return old;
  end if;
  -- UPDATE: the marker itself is immutable, and a milestone must stay a
  -- top-level work item so duration tracking can always find it.
  if old.milestone is not null then
    if new.milestone is distinct from old.milestone then
      raise exception 'The milestone marker on "%" cannot be changed.', old.title;
    end if;
    if new.kind <> 'work' then
      raise exception 'Milestone "%" must remain a work item.', old.title;
    end if;
  end if;
  return new;
end $$;

drop trigger if exists trg_si_protect_milestones on public.schedule_items;
create trigger trg_si_protect_milestones
  before delete or update on public.schedule_items
  for each row execute function public.protect_schedule_milestones();

-- ---------------------------------------------------------------------------
-- Atomic baseline lock
-- ---------------------------------------------------------------------------
-- SECURITY INVOKER (default): RLS still gates the writes, so only staff can
-- actually stamp anything. Copies current dates -> baseline for every work
-- item (undated items keep null baselines) and stamps the project.
create or replace function public.set_schedule_baseline(p_project uuid)
returns void language plpgsql
set search_path = ''
as $$
begin
  update public.schedule_items
     set baseline_start_date = start_date,
         baseline_end_date   = end_date
   where project_id = p_project
     and kind = 'work';

  update public.projects
     set baseline_set_at = now(),
         baseline_set_by = auth.uid()
   where id = p_project;
end $$;

-- ---------------------------------------------------------------------------
-- Backfill: give every existing project (templates included, so copies carry
-- them) its two milestones. Dates seed from the current schedule envelope —
-- min work start / max work end — or stay null on empty schedules.
-- schedule_items.created_by is NOT NULL (0021); attribute to the project's
-- creator, same as 0021 did. Projects without a creator are skipped here —
-- the app's ensure-milestones path creates theirs on first staff visit.
-- ---------------------------------------------------------------------------
insert into public.schedule_items
  (project_id, kind, title, start_date, end_date, duration_days, status, milestone, position, created_by)
select
  p.id, 'work', 'Job Start',
  w.min_start, w.min_start,
  case when w.min_start is null then null else 1 end,
  'not_started', 'job_start', coalesce(w.min_pos, 0) - 1, p.created_by
from public.projects p
left join lateral (
  select min(si.start_date) as min_start, min(si.position) as min_pos
  from public.schedule_items si
  where si.project_id = p.id and si.kind = 'work'
) w on true
where p.created_by is not null
  and not exists (
    select 1 from public.schedule_items si
    where si.project_id = p.id and si.milestone = 'job_start'
  );

insert into public.schedule_items
  (project_id, kind, title, start_date, end_date, duration_days, status, milestone, position, created_by)
select
  p.id, 'work', 'Substantial Completion',
  w.max_end, w.max_end,
  case when w.max_end is null then null else 1 end,
  'not_started', 'substantial_completion', coalesce(w.max_pos, 0) + 1, p.created_by
from public.projects p
left join lateral (
  select max(si.end_date) as max_end, max(si.position) as max_pos
  from public.schedule_items si
  where si.project_id = p.id and si.kind = 'work'
) w on true
where p.created_by is not null
  and not exists (
    select 1 from public.schedule_items si
    where si.project_id = p.id and si.milestone = 'substantial_completion'
  );

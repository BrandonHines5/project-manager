-- Adopt existing "Job Start" / "Substantial Completion" work items as the
-- protected milestones, instead of the rows 0069 synthesized next to them.
--
-- 0069's backfill created NEW milestone rows without checking whether the
-- project (or the Template it was built from) already had work items with
-- these exact names — leaving duplicates: the template's unflagged
-- "Job Start" sitting beside a synthesized flagged one. Product direction:
-- the existing named items ARE the milestones. This migration, per project
-- and milestone kind:
--   1. where an unflagged work item titled "Job Start" / "Substantial
--      Completion" (case-insensitive, trimmed; earliest-created wins) exists
--      alongside a flagged row, deletes the flagged row — it's 0069's
--      synthetic duplicate — and
--   2. flags the existing named item as the milestone. This also covers
--      projects that have the named items but never got flagged rows at all
--      (e.g. jobs created from the Template before the app code deployed).
--
-- Projects whose only "Job Start"/"Substantial Completion" rows are the
-- synthesized ones keep them unchanged. The milestone-protection trigger
-- blocks marker changes and deletes by design, so it's disabled around the
-- swap.

alter table public.schedule_items disable trigger trg_si_protect_milestones;

-- 1. Drop the synthetic flagged row wherever a titled original exists.
with kinds(kind, title_norm) as (
  values
    ('job_start'::public.schedule_milestone, 'job start'),
    ('substantial_completion'::public.schedule_milestone, 'substantial completion')
),
candidates as (
  select distinct on (si.project_id, k.kind)
         si.id as adopt_id, si.project_id, k.kind
  from public.schedule_items si
  join kinds k on lower(btrim(si.title)) = k.title_norm
  where si.kind = 'work'
    and si.milestone is null
  order by si.project_id, k.kind, si.created_at asc, si.id asc
)
delete from public.schedule_items f
using candidates c
where f.project_id = c.project_id
  and f.milestone = c.kind;

-- 2. Flag the titled original wherever the project+kind now has no
--    milestone (freshly vacated above, or never flagged in the first place).
with kinds(kind, title_norm) as (
  values
    ('job_start'::public.schedule_milestone, 'job start'),
    ('substantial_completion'::public.schedule_milestone, 'substantial completion')
),
candidates as (
  select distinct on (si.project_id, k.kind)
         si.id as adopt_id, si.project_id, k.kind
  from public.schedule_items si
  join kinds k on lower(btrim(si.title)) = k.title_norm
  where si.kind = 'work'
    and si.milestone is null
  order by si.project_id, k.kind, si.created_at asc, si.id asc
)
update public.schedule_items si
   set milestone = c.kind
  from candidates c
 where si.id = c.adopt_id
   and not exists (
     select 1 from public.schedule_items f
     where f.project_id = c.project_id
       and f.milestone = c.kind
   );

alter table public.schedule_items enable trigger trg_si_protect_milestones;

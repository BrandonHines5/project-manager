-- =====================================================================
-- 0071 — AI plan applications (audit trail + idempotency)
-- =====================================================================
-- Every time a staffer applies an AI smart-update plan, we record it here.
-- Two jobs:
--
--   1. Idempotency. The agent stamps each plan with a server-generated
--      plan_id; applyPlanAction inserts a row here BEFORE running the plan.
--      The UNIQUE constraint on plan_id means a second apply of the same
--      plan (a double-click, or the onsite walkthrough's blind retry after a
--      network error) loses the race and returns the first apply's stored
--      results instead of re-executing. That's the hard guard against the
--      documented double-apply hazard — most importantly duplicate texts to
--      subs, which can't be un-sent.
--
--   2. Audit. `mutations` and `results` capture exactly what the AI proposed
--      and what landed, per plan, attributed to who applied it — the raw
--      material for an acceptance-rate metric (proposed vs applied).
--
-- Staff-only. Writes are attributed to the caller (applied_by = auth.uid());
-- any staffer can read the log (it's an internal audit surface).

create table if not exists public.ai_plan_applications (
  id uuid primary key default gen_random_uuid(),
  -- The agent's per-turn plan id. Unique so the same plan can't be applied
  -- twice; this is the idempotency key.
  plan_id uuid not null unique,
  applied_by uuid not null references public.profiles(id) on delete cascade,
  -- The plan's text summary (what the agent said it would do).
  summary text,
  -- The full proposed plan and the per-mutation apply results, as returned
  -- to the client. jsonb so we can query into them later if needed.
  mutations jsonb not null,
  results jsonb,
  applied_count int not null default 0,
  failed_count int not null default 0,
  created_at timestamptz not null default now()
);

-- "What has this person applied recently" and dashboards over time.
create index if not exists idx_ai_plan_applications_applied_by
  on public.ai_plan_applications(applied_by, created_at desc);

comment on table public.ai_plan_applications is
  'Audit trail + idempotency ledger for applied AI smart-update plans. One '
  'row per apply, keyed by the agent''s plan_id (unique) so a plan can''t be '
  'applied twice.';

alter table public.ai_plan_applications enable row level security;

-- Any staffer can read the audit log; a staffer may only insert/modify rows
-- attributed to themselves. Scoped to `authenticated` so the anon API role
-- can never touch it.
drop policy if exists ai_plan_applications_staff_read on public.ai_plan_applications;
create policy ai_plan_applications_staff_read on public.ai_plan_applications
  for select to authenticated using (public.is_staff());

drop policy if exists ai_plan_applications_self_insert on public.ai_plan_applications;
create policy ai_plan_applications_self_insert on public.ai_plan_applications
  for insert to authenticated
  with check (public.is_staff() and applied_by = (select auth.uid()));

drop policy if exists ai_plan_applications_self_update on public.ai_plan_applications;
create policy ai_plan_applications_self_update on public.ai_plan_applications
  for update to authenticated
  using (public.is_staff() and applied_by = (select auth.uid()))
  with check (public.is_staff() and applied_by = (select auth.uid()));

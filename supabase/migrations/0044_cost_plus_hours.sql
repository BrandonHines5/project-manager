-- Cost-plus labor hours. On cost-plus jobs we bill actual cost, so we need to
-- capture hours worked — Lloyd (and other staff) log their hours right on the
-- daily job log for the day. Fixed-price jobs don't track hours, so the UI
-- only surfaces the field when projects.cost_plus is true.
--
-- Model (per the chosen design): a single hours_worked number per daily log,
-- attributed to the log's author (daily_logs.created_by). A per-job summary
-- rolls these up by person. Nullable so most logs (no hours that day) stay
-- blank; capped at 24h since a log covers a single day.

alter table public.projects
  add column if not exists cost_plus boolean not null default false;

alter table public.daily_logs
  add column if not exists hours_worked numeric(5,2)
    check (hours_worked is null or (hours_worked >= 0 and hours_worked <= 24));

-- Change orders quote their schedule impact.
--
-- Staff enter how many days of delay the change will cause (assuming the
-- client approves by the due date) and what each day of delay costs. The
-- product delay_days × delay_cost_per_day is folded into cost_delta on save
-- (app/actions/decisions.ts), so every existing consumer of cost_delta —
-- pricing page, projects rollup, dashboard webhook, client "Price" display —
-- already includes the delay cost without changes.
--
-- Both columns are client-visible through the existing decisions_client_read
-- policy (the drawer shows "X days × $Y/day" alongside the price). The UI
-- requires delay_days when drafting a change order (0 = no delay); columns
-- stay null on selections and on change orders saved before this feature.

alter table public.decisions
  add column if not exists delay_days integer,
  add column if not exists delay_cost_per_day numeric(14,2);

alter table public.decisions
  drop constraint if exists decisions_delay_nonnegative;
alter table public.decisions
  add constraint decisions_delay_nonnegative check (
    coalesce(delay_days, 0) >= 0 and coalesce(delay_cost_per_day, 0) >= 0
  );

comment on column public.decisions.delay_days is
  'Change orders only: days of schedule delay this change causes if approved by the due date. Required by the UI (0 = none). delay_days × delay_cost_per_day is included in cost_delta.';
comment on column public.decisions.delay_cost_per_day is
  'Change orders only: dollar cost per day of delay. Included in cost_delta via delay_days × delay_cost_per_day.';

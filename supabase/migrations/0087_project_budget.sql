-- Per-project budget by cost code — prep for the QuickBooks Online transition.
--
-- Two tables:
--
-- 1. project_budget_lines — the staff-entered budget per cost code, plus an
--    optional forecast override. The Budget tab derives everything else:
--      Changes to Budget  = approved decisions' cost items rolled up by code
--      New Budget         = Budget + Changes
--      Purchase Orders    = approved-PO committed costs by code (same math as
--                           the Pricing tab's Committed costs card)
--      Forecasted Remaining = forecast_override, defaulting to
--                             New Budget − Actual Costs when null
--      Total Forecasted   = Actuals + Forecasted Remaining
--      Variance           = Total Forecasted − New Budget
--    Budgets arrive via spreadsheet import today; once the SpecMagician bid
--    tool is finished they'll transfer from there.
--
-- 2. project_cost_actuals — "Actual costs to date" per cost code. The QBO
--    integration will upsert these rows (source='qbo') per cost code once
--    Hines Homes is on QuickBooks Online; until then the spreadsheet import
--    can stage interim values (source='import') so the tab is usable now.
--    One row per project+code — a sync replaces the amount, no history here.
--
-- Money-in/money-out sensitivity matches committed costs: RLS is staff-only
-- (clients/trades never read budgets), and the financial_access gate is
-- app-layer like the rest of the financial surface — the Budget page and its
-- server actions both check profiles.financial_access.

create table if not exists public.project_budget_lines (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  -- restrict, not set null: the cost code IS the row's identity. Codes are
  -- retired via is_active, not deleted, so this should never fire in practice.
  cost_code_id uuid not null references public.cost_codes(id) on delete restrict,
  budget_amount numeric(14,2) not null default 0,
  -- Staff-edited "Forecasted Remaining Costs". Null = use the default
  -- (New Budget − Actual Costs); clearing the cell reverts to the default.
  forecast_override numeric(14,2),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, cost_code_id)
);

create index if not exists idx_pbl_cost_code
  on public.project_budget_lines (cost_code_id);

drop trigger if exists trg_project_budget_lines_updated_at on public.project_budget_lines;
create trigger trg_project_budget_lines_updated_at
  before update on public.project_budget_lines
  for each row execute function public.touch_updated_at();

alter table public.project_budget_lines enable row level security;
drop policy if exists pbl_staff_all on public.project_budget_lines;
create policy pbl_staff_all on public.project_budget_lines
  for all using (public.is_staff()) with check (public.is_staff());

create table if not exists public.project_cost_actuals (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  cost_code_id uuid not null references public.cost_codes(id) on delete restrict,
  amount numeric(14,2) not null default 0,
  source text not null default 'import'
    constraint project_cost_actuals_source_check
    check (source in ('import', 'manual', 'qbo')),
  -- The date the amount is current through (QBO sync stamps its run date;
  -- imports stamp the import date).
  as_of date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, cost_code_id)
);

create index if not exists idx_pca_cost_code
  on public.project_cost_actuals (cost_code_id);

drop trigger if exists trg_project_cost_actuals_updated_at on public.project_cost_actuals;
create trigger trg_project_cost_actuals_updated_at
  before update on public.project_cost_actuals
  for each row execute function public.touch_updated_at();

alter table public.project_cost_actuals enable row level security;
drop policy if exists pca_staff_all on public.project_cost_actuals;
create policy pca_staff_all on public.project_cost_actuals
  for all using (public.is_staff()) with check (public.is_staff());

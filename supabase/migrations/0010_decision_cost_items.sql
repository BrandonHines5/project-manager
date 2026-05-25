-- Cost-code breakdown + markup for decisions.
-- Goal: staff itemize a decision's cost by code, apply a markup percent,
-- and the marked-up total flows into the existing `cost_delta` column
-- (which is what the client already sees). Staff also see the raw
-- subtotal + per-line cost; clients never see line items or markup.

-- 1. Global reference table of cost codes (one list shared across projects).
create table if not exists public.cost_codes (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  description text,
  is_active boolean not null default true,
  position int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists idx_cost_codes_active on public.cost_codes(is_active, position);

-- 2. Per-decision line items. Visible to staff only via RLS — clients can
--    never read this table, so the cost breakdown is fully hidden from them.
create table if not exists public.decision_cost_items (
  id uuid primary key default gen_random_uuid(),
  decision_id uuid not null references public.decisions(id) on delete cascade,
  cost_code_id uuid references public.cost_codes(id) on delete set null,
  description text,
  quantity numeric(14,4) not null default 1,
  unit text,
  unit_cost numeric(14,2) not null default 0,
  position int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists idx_dci_decision on public.decision_cost_items(decision_id, position);
-- Cover the FK so cost-code lookups (e.g. "what decisions referenced this code?")
-- don't seq-scan. Linter flags missing FK indexes as performance INFO.
create index if not exists idx_dci_cost_code on public.decision_cost_items(cost_code_id);

-- 3. Markup percent on the decision itself. The final marked-up total goes
--    into the existing `cost_delta` column on save (see app/actions/decisions.ts),
--    so the existing client query and dashboard webhook don't need to change.
alter table public.decisions
  add column if not exists markup_percent numeric(6,3) not null default 0;
comment on column public.decisions.markup_percent is
  'Markup applied to sum of decision_cost_items. cost_delta is recomputed from line items × (1 + markup_percent/100) on save. Hidden from clients via UI; the column itself is readable for transparency but not surfaced in the client portal.';

-- 4. RLS
alter table public.cost_codes          enable row level security;
alter table public.decision_cost_items enable row level security;

-- cost_codes is reference data. Any authenticated user can read so the UI
-- can resolve code → name labels (clients never see the picker but read
-- access is harmless and makes the staff page render the seed data without
-- a service-role workaround). Only staff can mutate.
drop policy if exists cost_codes_read_all on public.cost_codes;
create policy cost_codes_read_all on public.cost_codes
  for select to authenticated using (true);

drop policy if exists cost_codes_staff_write on public.cost_codes;
create policy cost_codes_staff_write on public.cost_codes
  for insert to authenticated with check (public.is_staff());

drop policy if exists cost_codes_staff_update on public.cost_codes;
create policy cost_codes_staff_update on public.cost_codes
  for update to authenticated using (public.is_staff()) with check (public.is_staff());

drop policy if exists cost_codes_staff_delete on public.cost_codes;
create policy cost_codes_staff_delete on public.cost_codes
  for delete to authenticated using (public.is_staff());

-- decision_cost_items: staff only. Clients have NO access.
drop policy if exists dci_staff_all on public.decision_cost_items;
create policy dci_staff_all on public.decision_cost_items
  for all using (public.is_staff()) with check (public.is_staff());

-- 5. Seed standard residential construction cost codes. Staff can extend
--    later. Codes are loosely grouped by trade with 100-step gaps so we
--    can insert new ones between siblings without renumbering.
insert into public.cost_codes (code, name, position) values
  ('10-100', 'Site Work / Excavation', 100),
  ('10-200', 'Demolition', 110),
  ('10-300', 'Permits & Fees', 120),
  ('20-100', 'Foundation', 200),
  ('20-200', 'Concrete Flatwork', 210),
  ('30-100', 'Framing – Lumber', 300),
  ('30-200', 'Framing – Labor', 310),
  ('40-100', 'Roofing', 400),
  ('40-200', 'Gutters', 410),
  ('50-100', 'Plumbing – Rough', 500),
  ('50-200', 'Plumbing – Finish', 510),
  ('60-100', 'Electrical – Rough', 600),
  ('60-200', 'Electrical – Finish', 610),
  ('70-100', 'HVAC', 700),
  ('80-100', 'Insulation', 800),
  ('80-200', 'Drywall', 810),
  ('90-100', 'Interior Trim & Doors', 900),
  ('90-200', 'Cabinets', 910),
  ('90-300', 'Countertops', 920),
  ('100-100', 'Flooring', 1000),
  ('100-200', 'Painting', 1010),
  ('110-100', 'Appliances', 1100),
  ('110-200', 'Plumbing Fixtures', 1110),
  ('110-300', 'Lighting Fixtures', 1120),
  ('120-100', 'Exterior Siding', 1200),
  ('120-200', 'Windows & Doors', 1210),
  ('130-100', 'Landscaping', 1300),
  ('150-100', 'General Conditions', 1400),
  ('150-200', 'Project Management', 1410),
  ('999-999', 'Other / Miscellaneous', 9999)
on conflict (code) do nothing;

-- 0122: Feature gating foundation — access levels (plans) + per-org assignment.
--
-- platform_plans: operator-defined access levels. `features` is a jsonb ARRAY
-- of feature keys; the catalog of valid keys lives in code (lib/features.ts),
-- so shipping a new gateable feature never needs a migration. The seeded
-- 'internal' plan is special-cased in code to ALWAYS resolve to every feature
-- (overrides ignored) — Hines and operator-provisioned orgs sit on it, and it
-- is the column DEFAULT so every existing org and new signup keeps full
-- access until the operator assigns a level: gating ships INERT.
--
-- Reads are authenticated-wide (the app layout resolves the active org's
-- feature set on the session client; feature lists are not secrets). Writes
-- are service-role-only (RLS enabled, no write policies) — the operator edits
-- through admin-client actions gated app-side to the legacy-org owner, the
-- same trust tier as provisioning.

create table public.platform_plans (
  key text primary key
    constraint platform_plans_key_format check (key ~ '^[a-z0-9][a-z0-9_-]{0,39}$'),
  name text not null
    constraint platform_plans_name_length check (length(trim(name)) between 1 and 80),
  features jsonb not null default '[]'::jsonb,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.platform_plans enable row level security;

create policy platform_plans_read on public.platform_plans
  for select to authenticated using (true);

insert into public.platform_plans (key, name, features, position)
values ('internal', 'Internal — all features', '[]'::jsonb, 0);

-- Org assignment + per-org exceptions. The FK's default NO ACTION means a
-- plan with organizations on it can't be deleted out from under them.
-- feature_overrides is a jsonb object { feature_key: boolean } layered over
-- the plan's list (true = grant, false = revoke) — the one-off concession
-- escape hatch. Ignored for 'internal'.
alter table public.organizations
  add column plan text not null default 'internal'
    references public.platform_plans (key) on update cascade,
  add column feature_overrides jsonb;

create index organizations_plan_idx on public.organizations (plan);

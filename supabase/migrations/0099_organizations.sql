-- 0099: Multi-tenant foundation — organizations + membership (Stage B1).
--
-- ADDITIVE ONLY, zero behavior change. Hines Homes becomes org #1 and every
-- org-owned root table gets `org_id NOT NULL DEFAULT <hines>` so existing code
-- keeps inserting without changes (the default stamps rows correctly while
-- there is exactly one org). Child tables (schedule_items, decisions, …)
-- resolve their org through their parent (project/company) and are NOT
-- stamped. Existing RLS policies are untouched in this stage — tightening to
-- org scope happens per-module in later stages (see docs/multi-tenant-plan.md).
--
-- The literal Hines org id below is intentional: DEFAULT needs a constant, and
-- later stages drop these defaults once inserts become org-aware.

-- ---------------------------------------------------------------------------
-- Organizations + membership
-- ---------------------------------------------------------------------------

create table organizations (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  slug       text not null unique,
  settings   jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

comment on table organizations is
  'Tenant builders. Every org-owned root table carries org_id; child tables resolve through their parent.';

insert into organizations (id, name, slug)
values ('018f6f2a-4c1e-4b8e-9d3a-7c5b2e8a1f10', 'Hines Homes', 'hines-homes');

create table organization_members (
  org_id      uuid not null references organizations(id) on delete cascade,
  profile_id  uuid not null references profiles(id) on delete cascade,
  member_role text not null default 'member'
    check (member_role in ('owner', 'admin', 'member')),
  created_at  timestamptz not null default now(),
  primary key (org_id, profile_id)
);

comment on table organization_members is
  'Which profiles belong to which org. member_role governs org administration (billing, members) — the app-level staff/client/trade role stays on profiles for now.';

insert into organization_members (org_id, profile_id, member_role)
select
  '018f6f2a-4c1e-4b8e-9d3a-7c5b2e8a1f10',
  p.id,
  case when lower(p.email) = 'brandon@hineshomes.com' then 'owner' else 'member' end
from profiles p;

-- ---------------------------------------------------------------------------
-- Membership helpers (security definer: read membership without RLS recursion)
-- ---------------------------------------------------------------------------

create or replace function is_org_member(org uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from organization_members m
    where m.org_id = org and m.profile_id = auth.uid()
  );
$$;

create or replace function current_org_ids()
returns setof uuid
language sql stable security definer
set search_path = public
as $$
  select m.org_id from organization_members m where m.profile_id = auth.uid();
$$;

-- Supabase default-grants EXECUTE to anon/authenticated directly (not via
-- PUBLIC), so anon needs its own revoke.
revoke all on function is_org_member(uuid) from public;
revoke all on function current_org_ids() from public;
revoke execute on function is_org_member(uuid) from anon;
revoke execute on function current_org_ids() from anon;
grant execute on function is_org_member(uuid) to authenticated;
grant execute on function current_org_ids() to authenticated;

-- ---------------------------------------------------------------------------
-- RLS on the new tables (reads for members; writes stay service-role-only
-- until Stage B5 onboarding builds org management)
-- ---------------------------------------------------------------------------

alter table organizations enable row level security;
alter table organization_members enable row level security;

create policy orgs_member_read on organizations
  for select to authenticated
  using (is_org_member(id));

create policy org_members_member_read on organization_members
  for select to authenticated
  using (is_org_member(org_id));

-- ---------------------------------------------------------------------------
-- Stamp org_id on org-owned ROOT tables. NOT NULL + constant DEFAULT is a
-- metadata-only change (no rewrite) and keeps every existing insert path
-- working unmodified while there is one org.
-- ---------------------------------------------------------------------------

alter table projects             add column org_id uuid not null default '018f6f2a-4c1e-4b8e-9d3a-7c5b2e8a1f10' references organizations(id);
alter table companies            add column org_id uuid not null default '018f6f2a-4c1e-4b8e-9d3a-7c5b2e8a1f10' references organizations(id);
alter table roles                add column org_id uuid not null default '018f6f2a-4c1e-4b8e-9d3a-7c5b2e8a1f10' references organizations(id);
alter table cost_codes           add column org_id uuid not null default '018f6f2a-4c1e-4b8e-9d3a-7c5b2e8a1f10' references organizations(id);
alter table purchasing_templates add column org_id uuid not null default '018f6f2a-4c1e-4b8e-9d3a-7c5b2e8a1f10' references organizations(id);
alter table app_settings         add column org_id uuid not null default '018f6f2a-4c1e-4b8e-9d3a-7c5b2e8a1f10' references organizations(id);
alter table rental_properties    add column org_id uuid not null default '018f6f2a-4c1e-4b8e-9d3a-7c5b2e8a1f10' references organizations(id);
alter table qbo_connection       add column org_id uuid not null default '018f6f2a-4c1e-4b8e-9d3a-7c5b2e8a1f10' references organizations(id);
alter table insurance_documents  add column org_id uuid not null default '018f6f2a-4c1e-4b8e-9d3a-7c5b2e8a1f10' references organizations(id);
alter table feedback_requests    add column org_id uuid not null default '018f6f2a-4c1e-4b8e-9d3a-7c5b2e8a1f10' references organizations(id);
alter table communications       add column org_id uuid not null default '018f6f2a-4c1e-4b8e-9d3a-7c5b2e8a1f10' references organizations(id);

create index projects_org_idx             on projects(org_id);
create index companies_org_idx            on companies(org_id);
create index roles_org_idx                on roles(org_id);
create index cost_codes_org_idx           on cost_codes(org_id);
create index purchasing_templates_org_idx on purchasing_templates(org_id);
create index app_settings_org_idx         on app_settings(org_id);
create index rental_properties_org_idx    on rental_properties(org_id);
create index qbo_connection_org_idx       on qbo_connection(org_id);
create index insurance_documents_org_idx  on insurance_documents(org_id);
create index feedback_requests_org_idx    on feedback_requests(org_id);
create index communications_org_idx       on communications(org_id);

-- app_settings today has unique(key); multi-org needs uniqueness per org.
-- Add the future-shaped index now — the old stricter constraint stays until
-- the stage that makes settings reads/writes org-aware drops it.
create unique index app_settings_org_key_idx on app_settings(org_id, key);

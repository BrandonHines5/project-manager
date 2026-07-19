-- 0111: Stage B5 (part 4) — org provisioning.
--
-- One atomic, tested path for standing up a new builder org:
-- create_organization(name, slug, owner) creates the organizations row,
-- enrolls the owner, and seeds the org-scoped catalogs (active cost codes +
-- roles) from a seed org — org #1 by default, whose lists are the standard
-- generic set. Branding needs no seed: parseBrandConfig already falls back
-- to a neutral app brand carrying the org's name, and the new owner edits
-- everything at /settings/organization.
--
-- Execution is SERVICE-ROLE-ONLY on purpose (plan: manual org creation
-- first, self-serve later behind billing) — no authenticated grant, so the
-- RPC is a support tool, not an app surface. purchasing_templates and
-- app_settings are deliberately NOT copied: they're a builder's own business
-- content, not generic defaults.

-- Two leftover single-tenant uniqueness rules would make orgs' catalogs
-- collide, so both become per-org: cost_codes.code was globally unique
-- (0010) and roles carried a global case-insensitive name index (0054).
-- App code never upserts on either, so nothing depends on the global
-- versions; within one org the behavior is unchanged.
alter table cost_codes drop constraint if exists cost_codes_code_key;
create unique index if not exists cost_codes_org_code_key
  on cost_codes (org_id, code);

drop index if exists uq_roles_name_lower;
create unique index if not exists uq_roles_org_name_lower
  on roles (org_id, lower(trim(name)));

create or replace function public.create_organization(
  p_name text,
  p_slug text,
  p_owner uuid,
  p_seed_from uuid default '018f6f2a-4c1e-4b8e-9d3a-7c5b2e8a1f10'
) returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  new_org uuid;
begin
  if p_name is null or char_length(trim(p_name)) not between 1 and 120 then
    raise exception 'Organization name must be 1-120 characters.';
  end if;
  if p_slug is null or p_slug !~ '^[a-z0-9][a-z0-9-]{1,62}$' then
    raise exception 'Slug must be lowercase letters, digits, and dashes.';
  end if;
  if not exists (select 1 from profiles where id = p_owner) then
    raise exception 'Owner profile not found.';
  end if;
  -- A typo'd seed id must fail loudly, not provision an org with silently
  -- empty catalogs. NULL stays the intentional no-seed path.
  if p_seed_from is not null
     and not exists (select 1 from organizations where id = p_seed_from) then
    raise exception 'Seed organization not found.';
  end if;

  insert into organizations (name, slug)
  values (trim(p_name), p_slug)
  returning id into new_org;

  insert into organization_members (org_id, profile_id, member_role)
  values (new_org, p_owner, 'owner');

  if p_seed_from is not null then
    -- Active cost codes only — a new org doesn't inherit retired numbers.
    insert into cost_codes (org_id, code, name, description, is_active, position)
    select new_org, code, name, description, is_active, position
    from cost_codes
    where org_id = p_seed_from and is_active;

    insert into roles (org_id, name, kind, position)
    select new_org, name, kind, position
    from roles
    where org_id = p_seed_from;
  end if;

  return new_org;
end;
$$;

revoke all on function create_organization(text, text, uuid, uuid) from public;
revoke execute on function create_organization(text, text, uuid, uuid) from anon;
revoke execute on function create_organization(text, text, uuid, uuid) from authenticated;
grant execute on function create_organization(text, text, uuid, uuid) to service_role;

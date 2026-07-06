-- Matching support for inbound communications (Quo webhook, email replies).

-- The 0066 provider-id index was partial (where provider_id is not null),
-- which ON CONFLICT can't infer from a plain column list — so PostgREST
-- upserts against (source, provider_id) would fail. A full unique index has
-- identical semantics (NULLs are distinct, so unattributed rows are still
-- unlimited) and supports upsert inference.
drop index if exists public.idx_comms_provider;
create unique index if not exists idx_comms_provider
  on public.communications(source, provider_id);

-- Candidate contacts for a phone number: companies (both numbers), project
-- client fields, and profiles. Uses the normalize_phone expression indexes
-- from 0066. Called only by the service-role webhook/cron paths.
create or replace function public.match_contacts_by_phone(p text)
returns table(
  kind text,              -- 'company' | 'project_client' | 'profile'
  company_id uuid,
  project_id uuid,
  profile_id uuid,
  display_name text
)
language sql
stable
set search_path = public
as $fn$
  select 'company', c.id, null::uuid, null::uuid, c.name
    from public.companies c
   where public.normalize_phone(p) is not null
     and (public.normalize_phone(c.phone) = public.normalize_phone(p)
       or public.normalize_phone(c.phone_secondary) = public.normalize_phone(p))
  union all
  select 'project_client', null::uuid, pr.id, null::uuid, coalesce(pr.client_name, pr.name)
    from public.projects pr
   where public.normalize_phone(p) is not null
     and public.normalize_phone(pr.client_phone) = public.normalize_phone(p)
  union all
  select 'project_client', null::uuid, pr.id, null::uuid, coalesce(pr.client_name_2, pr.name)
    from public.projects pr
   where public.normalize_phone(p) is not null
     and public.normalize_phone(pr.client_phone_2) = public.normalize_phone(p)
  union all
  select 'profile', pf.company_id, null::uuid, pf.id, coalesce(pf.full_name, pf.email)
    from public.profiles pf
   where public.normalize_phone(p) is not null
     and public.normalize_phone(pf.phone) = public.normalize_phone(p);
$fn$;

-- Same idea for an email address (exact, case-insensitive).
create or replace function public.match_contacts_by_email(p text)
returns table(
  kind text,
  company_id uuid,
  project_id uuid,
  profile_id uuid,
  display_name text
)
language sql
stable
set search_path = public
as $fn$
  select 'company', c.id, null::uuid, null::uuid, c.name
    from public.companies c
   where c.email is not null and lower(c.email) = lower(p)
  union all
  select 'project_client', null::uuid, pr.id, null::uuid, coalesce(pr.client_name, pr.name)
    from public.projects pr
   where pr.client_email is not null and lower(pr.client_email) = lower(p)
  union all
  select 'project_client', null::uuid, pr.id, null::uuid, coalesce(pr.client_name_2, pr.name)
    from public.projects pr
   where pr.client_email_2 is not null and lower(pr.client_email_2) = lower(p)
  union all
  select 'profile', pf.company_id, null::uuid, pf.id, coalesce(pf.full_name, pf.email)
    from public.profiles pf
   where pf.email is not null and lower(pf.email) = lower(p);
$fn$;

-- Service-role only: these read across RLS'd tables for webhook attribution
-- and must never be callable by browser sessions.
revoke all on function public.match_contacts_by_phone(text) from public;
revoke all on function public.match_contacts_by_phone(text) from anon;
revoke all on function public.match_contacts_by_phone(text) from authenticated;
grant execute on function public.match_contacts_by_phone(text) to service_role;

revoke all on function public.match_contacts_by_email(text) from public;
revoke all on function public.match_contacts_by_email(text) from anon;
revoke all on function public.match_contacts_by_email(text) from authenticated;
grant execute on function public.match_contacts_by_email(text) to service_role;

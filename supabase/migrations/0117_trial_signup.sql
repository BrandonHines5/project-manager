-- 0117: Stage S (part 2) — self-serve trial signup support.
--
-- The public POST /api/trial/signup route (called server-to-server by the
-- separate sales site) mints a brand-new SANDBOX org + owner. Two DB pieces
-- back it:
--
--  1. create_sandbox_organization() — an atomic wrapper over the shipped
--     create_organization() (0111) that also stamps the trial lifecycle. Doing
--     the stamp INSIDE one function means the whole thing is one transaction:
--     if the status update fails, org creation rolls back too, so the signup
--     path can never leave a half-provisioned org that's stuck as a
--     never-expiring 'active_subscriber' (a free-forever leak).
--
--  2. trial_signup_attempts + record_trial_signup_attempt() — a serverless-safe
--     rate limiter (in-memory counters don't survive across Vercel lambda
--     invocations). The route's primary gate is the TRIAL_SIGNUP_SECRET shared
--     header; this is defense-in-depth if that secret ever leaks.
--
-- Both functions are SERVICE-ROLE-ONLY (the route calls them via the admin
-- client) — never an authenticated/anon app surface.

-- 1. Atomic sandbox-org creation ------------------------------------------------

create or replace function public.create_sandbox_organization(
  p_name text,
  p_slug text,
  p_owner uuid,
  p_trial_days integer default 7
) returns table (org_id uuid, expires_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  new_org uuid;
  v_expires timestamptz;
begin
  if p_trial_days is null or p_trial_days < 1 or p_trial_days > 365 then
    raise exception 'Trial length must be between 1 and 365 days.';
  end if;

  -- Reuse the provisioning path: org row + owner enrollment + active cost
  -- codes/roles seeded from Hines (org #1, the create_organization default).
  -- Runs in THIS function's transaction — the stamp below rides along, so a
  -- created sandbox org always carries its trial status + expiry.
  new_org := public.create_organization(p_name, p_slug, p_owner);

  v_expires := now() + make_interval(days => p_trial_days);

  update public.organizations
     set status = 'sandbox_active',
         sandbox_expires_at = v_expires
   where id = new_org;

  return query select new_org, v_expires;
end;
$$;

revoke all on function create_sandbox_organization(text, text, uuid, integer) from public;
revoke execute on function create_sandbox_organization(text, text, uuid, integer) from anon;
revoke execute on function create_sandbox_organization(text, text, uuid, integer) from authenticated;
grant execute on function create_sandbox_organization(text, text, uuid, integer) to service_role;

comment on function public.create_sandbox_organization(text, text, uuid, integer) is
  'Atomic self-serve trial provisioning: create_organization() seeded from Hines, then stamp status=sandbox_active + sandbox_expires_at. Service-role only.';

-- 2. Rate-limit log + check -----------------------------------------------------

create table if not exists public.trial_signup_attempts (
  id         bigint generated always as identity primary key,
  ip         text,
  email      text not null,
  created_at timestamptz not null default now()
);

-- RLS on with NO policies → only the service role (which bypasses RLS) touches
-- it. Same "service-role-only" pattern as org_integrations.
alter table public.trial_signup_attempts enable row level security;

create index if not exists trial_signup_attempts_created_idx
  on public.trial_signup_attempts (created_at);
create index if not exists trial_signup_attempts_email_idx
  on public.trial_signup_attempts (email, created_at);
create index if not exists trial_signup_attempts_ip_idx
  on public.trial_signup_attempts (ip, created_at);

comment on table public.trial_signup_attempts is
  'Append log backing the trial-signup rate limiter. Service-role only; pruned opportunistically by record_trial_signup_attempt (2-day tail).';

create or replace function public.record_trial_signup_attempt(
  p_ip text,
  p_email text
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email       text := lower(trim(p_email));
  v_ip          text := nullif(trim(coalesce(p_ip, '')), '');
  v_ip_count    integer;
  v_email_count integer;
begin
  -- Opportunistic prune keeps the log bounded (volume is tiny; created_at is
  -- indexed). 2-day tail is wider than the widest window checked below.
  delete from public.trial_signup_attempts
   where created_at < now() - interval '2 days';

  insert into public.trial_signup_attempts (ip, email)
  values (v_ip, v_email);

  -- Count INCLUDING the row just inserted, so the Nth attempt trips the limit.
  select count(*) into v_ip_count
    from public.trial_signup_attempts
   where v_ip is not null
     and ip = v_ip
     and created_at > now() - interval '1 hour';

  select count(*) into v_email_count
    from public.trial_signup_attempts
   where email = v_email
     and created_at > now() - interval '1 day';

  -- Up to 5 attempts per IP per hour and 3 per email per day. A blank/absent IP
  -- can't be attributed, so it skips the IP limit — the email limit still binds.
  return (v_ip is null or v_ip_count <= 5)
     and (v_email_count <= 3);
end;
$$;

revoke all on function record_trial_signup_attempt(text, text) from public;
revoke execute on function record_trial_signup_attempt(text, text) from anon;
revoke execute on function record_trial_signup_attempt(text, text) from authenticated;
grant execute on function record_trial_signup_attempt(text, text) to service_role;

comment on function public.record_trial_signup_attempt(text, text) is
  'Records a trial-signup attempt and returns whether it is within limits (5/IP/hour, 3/email/day). Service-role only.';

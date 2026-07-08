-- Client Portal (item 7): give each of a job's client contacts their own login.
--
-- A job carries up to two client contacts as denormalized text (client_email /
-- client_email_2, mirrored from the dashboard). Staff send each an invite; the
-- client accepts on a public tokenized page where they set a password and
-- acknowledge a disclaimer, which creates/links their account and adds them to
-- the project as a client member.
--
-- The disclaimer they accept states that an approval or decision from any one
-- client contact is binding on all client contacts for the job — i.e. approval
-- from either party is the same as approval from both. (This mirrors how
-- client_decide_decision already works: whichever client member acts first
-- binds the decision for the whole household.)

-- Record disclaimer acceptance on the profile (auditable; nullable so existing
-- accounts are simply "not yet accepted").
alter table public.profiles
  add column if not exists disclaimer_accepted_at timestamptz,
  add column if not exists disclaimer_version text;

-- One invite per client contact per job. The unguessable token is the entire
-- credential for the public accept page — there are NO anon RLS policies, so
-- the accept flow runs on the service-role admin client (same model as the
-- bid/PO/insurance public pages). Revoking an invite = nulling its token.
create table if not exists public.client_invites (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  email text not null,
  name text,
  token text unique,
  contact_slot smallint check (contact_slot in (1, 2)),
  invited_by uuid references public.profiles(id) on delete set null,
  invited_at timestamptz not null default now(),
  accepted_at timestamptz,
  accepted_profile_id uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_client_invites_project on public.client_invites(project_id);
create index if not exists idx_client_invites_token on public.client_invites(token);
create index if not exists idx_client_invites_accepted_profile
  on public.client_invites(accepted_profile_id);
-- Hard guarantee of the one-open-invite-per-contact-per-job rule (the app also
-- refreshes an open invite in place). Scoped to unaccepted invites so a
-- re-invite after acceptance is still allowed.
create unique index if not exists uq_client_invites_open
  on public.client_invites (project_id, email)
  where accepted_at is null;

alter table public.client_invites enable row level security;

-- Staff manage invites in-app. The public accept page never touches this table
-- under an anon session — it uses the admin client — so there is deliberately
-- no anon/authenticated-client policy here.
drop policy if exists client_invites_staff_all on public.client_invites;
create policy client_invites_staff_all on public.client_invites
  for all using (public.is_staff()) with check (public.is_staff());

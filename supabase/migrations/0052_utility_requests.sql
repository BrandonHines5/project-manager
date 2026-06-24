-- Initiate Utilities.
--
-- Kicking off a new job means turning utilities on at the property. This table
-- tracks, per project, a utility-provider new-service request: the staff fill
-- the provider's official forms (app overlays the answers onto the blank PDFs),
-- email them in, then walk the request through the external pay-by-link flow
-- back to "paid". Phase 1 ships one provider: Central Arkansas Water (CAW).
--
-- form_data holds every answer (the zod/TS schema is the source of truth for
-- its shape, so the form can grow new fields without a migration). Generated
-- PDFs are app-owned artifacts stored in the shared `project-files` bucket;
-- their paths live on the row rather than in a user-managed files table.

do $$ begin
  create type public.utility_provider as enum ('central_arkansas_water');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.utility_request_status as enum (
    'draft', 'submitted', 'awaiting_payment', 'paid', 'complete'
  );
exception when duplicate_object then null; end $$;

create table if not exists public.utility_requests (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  provider public.utility_provider not null default 'central_arkansas_water',
  status public.utility_request_status not null default 'draft',
  form_data jsonb not null default '{}'::jsonb,
  generated_file_paths text[] not null default '{}',
  payment_url text,
  submitted_at timestamptz,
  paid_at timestamptz,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_utility_requests_project
  on public.utility_requests(project_id, created_at desc);
create index if not exists idx_utility_requests_status
  on public.utility_requests(status);

-- updated_at maintenance (reuses the shared trigger fn from 0001).
drop trigger if exists touch_utility_requests on public.utility_requests;
create trigger touch_utility_requests before update on public.utility_requests
  for each row execute function public.touch_updated_at();

-- RLS: staff-only, like the rest of the internal tracker tables.
alter table public.utility_requests enable row level security;

drop policy if exists utility_requests_staff_all on public.utility_requests;
create policy utility_requests_staff_all on public.utility_requests
  for all using (public.is_staff()) with check (public.is_staff());

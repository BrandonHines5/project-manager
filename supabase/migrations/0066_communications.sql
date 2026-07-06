-- Unified log of emails / SMS / calls tied to projects, companies, and people.
-- Comments stay in their per-entity tables (decision_comments, bid_comments,
-- po_comments, schedule_item_comments, daily_log_comments); this table holds
-- channel traffic only. Rows are written by the server (admin client) — no
-- client/trade writes, ever.

do $$ begin
  create type comm_channel as enum ('email', 'sms', 'call');
exception when duplicate_object then null; end $$;

do $$ begin
  create type comm_direction as enum ('outbound', 'inbound');
exception when duplicate_object then null; end $$;

do $$ begin
  create type comm_status as enum ('logged', 'needs_review', 'ignored');
exception when duplicate_object then null; end $$;

create table if not exists public.communications (
  id uuid primary key default gen_random_uuid(),
  channel comm_channel not null,
  direction comm_direction not null,
  status comm_status not null default 'logged',
  project_id uuid references public.projects(id) on delete set null,
  company_id uuid references public.companies(id) on delete set null,
  -- Counterparty profile (client/trade) when known — this is what lets the
  -- client read their own conversation rows under RLS.
  profile_id uuid references public.profiles(id) on delete set null,
  -- Staff profile who initiated an outbound send, when known.
  sent_by uuid references public.profiles(id) on delete set null,
  from_address text,
  to_address text,
  counterparty_name text,
  subject text,
  body text,
  source text not null,          -- 'app' | 'quo' | 'resend_inbound' | 'outlook'
  source_kind text,              -- app send kind ('bid_invite', …) or webhook event type
  provider_id text,              -- OpenPhone msg/call id, Resend email id, Graph internetMessageId
  call_duration_seconds int,
  call_recording_url text,
  meta jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- Idempotency for webhook ingestion: one row per provider event/message.
create unique index if not exists idx_comms_provider
  on public.communications(source, provider_id) where provider_id is not null;
create index if not exists idx_comms_project on public.communications(project_id, occurred_at desc);
create index if not exists idx_comms_company on public.communications(company_id, occurred_at desc);
create index if not exists idx_comms_review on public.communications(occurred_at desc) where status = 'needs_review';

alter table public.communications enable row level security;

drop policy if exists comms_staff_all on public.communications;
create policy comms_staff_all on public.communications
  for all using (public.is_staff()) with check (public.is_staff());

-- Clients: only their own conversations, only once matched to one of their
-- projects. profile_id is stamped by the send context / matching engine.
drop policy if exists comms_client_read on public.communications;
create policy comms_client_read on public.communications
  for select using (
    public.current_role_name() = 'client'
    and status = 'logged'
    and profile_id = auth.uid()
    and project_id is not null
    and public.is_member_of_project(project_id)
  );

-- Trades: their company's traffic only.
drop policy if exists comms_trade_read on public.communications;
create policy comms_trade_read on public.communications
  for select using (
    public.current_role_name() = 'trade'
    and status = 'logged'
    and company_id = public.current_company_id()
  );

-- Phone normalization for matching inbound traffic to companies / project
-- clients / profiles. Strips non-digits and compares on the last 10 digits
-- (US numbers), so "(555) 555-1234" matches "+15555551234".
create or replace function public.normalize_phone(p text)
returns text
language sql
immutable
set search_path = ''
as $fn$
  select case
    when p is null then null
    when length(regexp_replace(p, '\D', '', 'g')) >= 10
      then right(regexp_replace(p, '\D', '', 'g'), 10)
    else nullif(regexp_replace(p, '\D', '', 'g'), '')
  end;
$fn$;

create index if not exists idx_companies_phone_norm
  on public.companies (public.normalize_phone(phone));
create index if not exists idx_companies_phone2_norm
  on public.companies (public.normalize_phone(phone_secondary));
create index if not exists idx_projects_client_phone_norm
  on public.projects (public.normalize_phone(client_phone));
create index if not exists idx_projects_client_phone2_norm
  on public.projects (public.normalize_phone(client_phone_2));
create index if not exists idx_profiles_phone_norm
  on public.profiles (public.normalize_phone(phone));

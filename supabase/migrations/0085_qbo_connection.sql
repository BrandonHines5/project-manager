-- QuickBooks Online OAuth connection (PO → QBO → Adaptive sync).
--
-- Stores the OAuth 2.0 tokens + realm (company) id for the app's connection to
-- a QuickBooks Online company. Approved Purchase Orders are pushed into QBO,
-- where Adaptive's native QuickBooks sync imports them so vendor bills can be
-- matched against the PO amount at approval time.
--
-- SECURITY: the refresh_token is a long-lived credential (~100-day rolling).
-- Unlike outlook_sync_state (whose delta_link is not a secret and is staff-
-- readable), this table has NO select/write policy at all — with RLS enabled
-- that means only the service-role key can touch it. The settings UI reads a
-- redacted status through a server action that uses the admin client behind
-- requireStaff(); the tokens themselves never reach a browser session.
--
-- One row per connected company (realm_id PK). v1 connects a single company,
-- but keying on realm leaves room to connect more later without a schema change.

create table if not exists public.qbo_connection (
  realm_id text primary key,
  environment text not null default 'production', -- 'production' | 'sandbox'
  access_token text not null,
  refresh_token text not null,
  access_token_expires_at timestamptz not null,
  refresh_token_expires_at timestamptz not null,
  company_name text,                              -- from CompanyInfo, for display
  connected_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists trg_qbo_connection_updated_at on public.qbo_connection;
create trigger trg_qbo_connection_updated_at before update on public.qbo_connection
  for each row execute function public.touch_updated_at();

-- RLS on, no policies: service-role only. Tokens are secret — no client reads.
alter table public.qbo_connection enable row level security;

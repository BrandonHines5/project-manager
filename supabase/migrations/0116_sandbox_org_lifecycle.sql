-- 0116: Sandbox / trial org lifecycle — S1 foundation.
--
-- Adds a lifecycle status + trial expiry to organizations for the self-serve
-- trial that a future sales-site signup (S2) will mint. Default
-- 'active_subscriber' so Hines and EVERY existing/provisioned org is a full
-- subscriber that NEVER sees a paywall or an expiry — only orgs the signup
-- path marks 'sandbox_active' participate in the lifecycle. Inert until S2
-- exists (there are no sandbox orgs yet), so this is safe to ship first.
--
-- Lifecycle: signup → 'sandbox_active' + sandbox_expires_at = now()+7d →
-- (on expiry) 'sandbox_expired' (frozen: readable, not writable — "subscribe
-- to keep your data") → (on subscribe, S3) 'active_subscriber'. The 37-day
-- grace hard-delete (S4) and the write-block that consumes org_writable (S1b)
-- land in their own PRs.

alter table organizations
  add column if not exists status text not null default 'active_subscriber'
    check (status in ('sandbox_active', 'sandbox_expired', 'active_subscriber'));

alter table organizations
  add column if not exists sandbox_expires_at timestamptz;

comment on column organizations.status is
  'Lifecycle: sandbox_active (in trial) | sandbox_expired (trial over, frozen read-only) | active_subscriber (default; paying or non-trial — never expires).';
comment on column organizations.sandbox_expires_at is
  'When a sandbox trial ends (7 days from signup). Null for active_subscriber orgs. The grace hard-delete (S4) keys off this + 30 days.';

-- Index the sweep the expiry-flip and (future) cleanup cron run: sandbox orgs
-- ordered by when they expire. Partial so it stays tiny (subscribers excluded).
create index if not exists organizations_sandbox_expiry_idx
  on organizations (sandbox_expires_at)
  where status in ('sandbox_active', 'sandbox_expired');

-- Whether an org may be MUTATED. False only for a sandbox whose trial has
-- expired — that org is frozen read-only until it subscribes, so the owner can
-- still see everything they'd keep. active_subscriber and still-in-trial
-- sandbox_active orgs are writable. A missing/null org resolves to writable so
-- this never false-freezes a legitimate write. SECURITY DEFINER so it can read
-- status regardless of the caller's row visibility; defined here so the S1b
-- write-block (RLS and/or app-layer) is a clean drop-in.
create or replace function public.org_writable(p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select o.status <> 'sandbox_expired'
       from public.organizations o
      where o.id = p_org),
    true
  );
$$;

grant execute on function public.org_writable(uuid) to authenticated;

comment on function public.org_writable(uuid) is
  'True unless the org is a sandbox whose trial has expired (frozen: read-only). Consumed by the S1b sandbox write-block.';

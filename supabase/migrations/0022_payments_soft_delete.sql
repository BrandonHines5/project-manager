-- Payments are money. Hard-delete is wrong: a misclick costs the audit trail.
-- Soft-delete via `deleted_at`, plus a thin audit log so we can answer "who
-- deleted this and when" without scanning logs.

alter table public.project_payments
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by uuid references public.profiles(id) on delete restrict;

create index if not exists idx_pp_active
  on public.project_payments(project_id, paid_on desc)
  where deleted_at is null;

create table if not exists public.payment_audit (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references public.project_payments(id) on delete restrict,
  action text not null check (action in ('create', 'update', 'delete', 'restore')),
  actor_id uuid references public.profiles(id) on delete restrict,
  before jsonb,
  after jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_payment_audit_payment
  on public.payment_audit(payment_id, created_at desc);

alter table public.payment_audit enable row level security;

drop policy if exists payment_audit_staff_read on public.payment_audit;
create policy payment_audit_staff_read on public.payment_audit
  for select using (public.is_staff());

drop policy if exists payment_audit_staff_insert on public.payment_audit;
create policy payment_audit_staff_insert on public.payment_audit
  for insert with check (public.is_staff());

-- Update the existing client-read policy: clients should not see soft-deleted
-- payments. Staff still see everything (their policy is for-all).
drop policy if exists pp_client_read on public.project_payments;
create policy pp_client_read on public.project_payments
  for select using (
    deleted_at is null
    and public.current_role_name() = 'client'
    and public.is_member_of_project(project_id)
  );

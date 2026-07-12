-- Client invoices — QBO hybrid model.
--
-- Invoicing stays in QuickBooks Online (QBO creates the invoice, emails the
-- client, sends reminders, and takes the online payment on Intuit's hosted
-- page). The app's job is to SURFACE that: each project links to a QBO
-- Customer, and qbo_invoices caches that customer's invoices so the client
-- portal can list them (with the hosted "View & pay" link) without a QBO API
-- call per page view. Intuit webhooks + a manual "Sync now" keep the cache
-- fresh; when a payment lands, staff get an in-app notification.
--
-- projects.qbo_customer_id / qbo_customer_name: the linked QBO Customer (job).
-- Bare text ids — QBO lives in another system, so no FK. The name is a display
-- snapshot taken at link time.

alter table public.projects
  add column if not exists qbo_customer_id text,
  add column if not exists qbo_customer_name text;

-- One row per cached QBO invoice. Written ONLY by the service-role client
-- (webhook + staff sync action); RLS below grants read-only access. project_id
-- is a bare uuid (no FK) to match the qbo_po_sync / project_history pattern —
-- a project delete can't deadlock on sync bookkeeping, and orphaned rows are
-- unreachable anyway (every read path goes through the project).
create table if not exists public.qbo_invoices (
  id uuid primary key default gen_random_uuid(),
  qbo_realm_id text not null,
  qbo_invoice_id text not null,
  project_id uuid not null,
  doc_number text,
  txn_date date,
  due_date date,
  total numeric(14, 2) not null default 0,
  balance numeric(14, 2) not null default 0,
  -- 'open' | 'paid' (balance hit 0) | 'voided' | 'deleted' (removed in QBO —
  -- kept for staff/history, hidden from clients). Overdue is derived in the UI
  -- from due_date + balance, not stored.
  status text not null default 'open'
    constraint qbo_invoices_status_check
    check (status in ('open', 'paid', 'voided', 'deleted')),
  customer_memo text,
  -- Intuit's hosted pay page for this invoice (include=invoiceLink). Null when
  -- online payments aren't enabled on the QBO side.
  invoice_link text,
  last_synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (qbo_realm_id, qbo_invoice_id)
);

create index if not exists qbo_invoices_project_idx
  on public.qbo_invoices (project_id);

drop trigger if exists trg_qbo_invoices_updated_at on public.qbo_invoices;
create trigger trg_qbo_invoices_updated_at before update on public.qbo_invoices
  for each row execute function public.touch_updated_at();

alter table public.qbo_invoices enable row level security;

-- Staff see every cached invoice (including voided/deleted, for history).
drop policy if exists qi_staff_read on public.qbo_invoices;
create policy qi_staff_read on public.qbo_invoices
  for select using (public.is_staff());

-- Clients see live invoices on their own projects. Voided/deleted stay hidden
-- — QBO no longer considers them receivable.
drop policy if exists qi_client_read on public.qbo_invoices;
create policy qi_client_read on public.qbo_invoices
  for select using (
    public.current_role_name() = 'client'
    and status in ('open', 'paid')
    and public.is_member_of_project(project_id)
  );

-- No trade policy, no insert/update/delete policies: trades never see client
-- invoices, and all writes go through the service-role client.

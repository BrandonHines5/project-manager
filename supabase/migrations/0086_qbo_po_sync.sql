-- Tracks which of our Purchase Orders have been pushed to QuickBooks Online,
-- for idempotency (don't create the same PO twice) and to show sync status in
-- the PO drawer.
--
-- Like qbo_connection: RLS enabled with NO policies → service-role only. The
-- push runs through the admin/service-role client, and staff read status via a
-- server action (getQboPoSyncStatus) behind requireStaff(). purchase_order_id
-- is a bare uuid (no FK) to match the project_history pattern — keeps a
-- purchase-order delete from deadlocking on this bookkeeping row.

create table if not exists public.qbo_po_sync (
  purchase_order_id uuid primary key,
  qbo_realm_id text not null,
  qbo_po_id text,                 -- QBO PurchaseOrder.Id once created
  doc_number text,                -- DocNumber we pushed (Adaptive matches on this)
  sync_token text,                -- QBO SyncToken for future updates
  status text not null default 'synced'
    constraint qbo_po_sync_status_check check (status in ('synced', 'error')),
  last_error text,
  synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists trg_qbo_po_sync_updated_at on public.qbo_po_sync;
create trigger trg_qbo_po_sync_updated_at before update on public.qbo_po_sync
  for each row execute function public.touch_updated_at();

alter table public.qbo_po_sync enable row level security;

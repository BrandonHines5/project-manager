-- =====================================================================
-- 0095 — Purchasing: Files-tab links, PO←decision provenance, templates
-- =====================================================================
--   * bid_package_attachments.project_file_id / po_attachments.
--     project_file_id — a bid/PO attachment can LINK a document already in
--     the Files tab instead of re-uploading. The blob belongs to the Files
--     tab: attachment reconcilers must never storage.remove() a linked
--     path (app-layer guard), and the 0089 purge already cross-checks
--     project_files before deleting any blob.
--   * purchase_orders.source_decision_id — provenance for POs created from
--     an approved selection/change order (mirror of source_bid_recipient_id).
--     First and only purchase_orders↔decisions FK — resolve chips with
--     separate queries, not embeds, to keep PGRST201 out of play.
--   * purchasing_templates — org-wide staff templates usable as EITHER a
--     bid request or a purchase order. line_items is jsonb
--     [{cost_code_id, description, quantity, unit, unit_cost|null}]:
--     instantiating as a bid drops unit_cost (subs price bids), as a PO
--     defaults missing unit_cost to 0.

alter table public.bid_package_attachments
  add column if not exists project_file_id uuid
    references public.project_files(id) on delete set null;
create index if not exists idx_bpa_project_file
  on public.bid_package_attachments(project_file_id);

alter table public.po_attachments
  add column if not exists project_file_id uuid
    references public.project_files(id) on delete set null;
create index if not exists idx_poa_project_file
  on public.po_attachments(project_file_id);

alter table public.purchase_orders
  add column if not exists source_decision_id uuid
    references public.decisions(id) on delete set null;
create index if not exists idx_po_source_decision
  on public.purchase_orders(source_decision_id);

create table if not exists public.purchasing_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  title text not null,
  scope text,
  flat_fee boolean not null default false,
  line_items jsonb not null default '[]'::jsonb,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

alter table public.purchasing_templates enable row level security;
drop policy if exists ptmpl_staff_all on public.purchasing_templates;
create policy ptmpl_staff_all on public.purchasing_templates
  for all using (public.is_staff()) with check (public.is_staff());

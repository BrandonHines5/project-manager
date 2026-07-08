-- Optional link from decision cost line items to the HH-SpecMagician item
-- catalog (a SEPARATE Supabase project — see lib/supabase/specmagician.ts).
--
-- Cross-database references can't carry an FK (same convention as
-- utility_requests.crm_project_id in 0056): store the remote catalog_items.id
-- as a bare uuid plus a display snapshot of the item code captured at link
-- time, so line items render without a live cross-project join.

alter table public.decision_cost_items
  add column if not exists catalog_item_id uuid,
  add column if not exists catalog_item_code text;

comment on column public.decision_cost_items.catalog_item_id is
  'catalog_items.id in the HH-SpecMagician Supabase project. Bare uuid — no FK across databases.';
comment on column public.decision_cost_items.catalog_item_code is
  'Snapshot of the linked catalog item''s code at link time (display without a cross-project join).';

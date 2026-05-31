-- The RLS check on schedule_items for trades is:
--   exists (select 1 from schedule_assignments sa
--           where sa.schedule_item_id = ?
--             and (sa.profile_id = auth.uid() or sa.company_id = ?))
-- The existing single-column indexes on (schedule_item_id), (profile_id),
-- (company_id) force pg to choose one then filter. Compound indexes on the
-- join columns make this a clean index-only lookup. Cheap insert cost given
-- the table size; large RLS-query win.

create index if not exists idx_sa_item_profile
  on public.schedule_assignments(schedule_item_id, profile_id);

create index if not exists idx_sa_item_company
  on public.schedule_assignments(schedule_item_id, company_id);

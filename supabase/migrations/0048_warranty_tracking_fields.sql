-- Warranty tracking spreadsheet fields.
--
-- The warranty page becomes an editable, spreadsheet-style tracker that mirrors
-- the worksheet staff used to keep in Excel. Most columns already exist:
--   Address                -> projects.address
--   Owner Name             -> projects.client_name
--   Owner Noted Issue      -> schedule_items.title
--   Who is Fixing It       -> schedule_assignments (company)
--   When Are They Fixing It-> schedule_items.due_date
--   Status                 -> schedule_items.status
--
-- These three are net-new. Warranty End Date is per-home, so it lives on the
-- project. Date Noted + Resolution are per-issue, so they live on the to-do row.

alter table public.projects
  add column if not exists warranty_end_date date;

alter table public.schedule_items
  add column if not exists warranty_date_noted date,
  add column if not exists warranty_resolution text;

comment on column public.projects.warranty_end_date is
  'End of the warranty period for this home. Surfaced on the Warranty tracker.';
comment on column public.schedule_items.warranty_date_noted is
  'Date the owner reported this warranty issue. Warranty tracker only.';
comment on column public.schedule_items.warranty_resolution is
  'How the warranty issue is being / was resolved. Warranty tracker only.';

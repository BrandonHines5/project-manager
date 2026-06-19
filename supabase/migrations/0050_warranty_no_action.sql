-- "Not Covered / No Action" is a warranty-specific terminal disposition: the
-- issue was reviewed and nothing will be done (not covered under warranty, or
-- no action needed). It's hidden alongside completed items on the tracker.
--
-- Modeled as a boolean flag rather than a new schedule_item_status enum value so
-- it stays scoped to the warranty module and doesn't leak into the shared
-- schedule/to-do UIs that switch over the status enum.
alter table public.schedule_items
  add column if not exists warranty_no_action boolean not null default false;

comment on column public.schedule_items.warranty_no_action is
  'Warranty tracker: issue reviewed, not covered / no action. Hidden with completed.';

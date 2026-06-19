-- "Who is Fixing It" on the warranty tracker is captured as free-form text:
-- the source worksheet uses vendor shorthand, people's first names, and
-- combinations ("Lloyd/Adam/Axel", "N/A") that don't map to single companies.
alter table public.schedule_items
  add column if not exists warranty_who_fixing text;

comment on column public.schedule_items.warranty_who_fixing is
  'Free-text "who is fixing it" for warranty items (vendor/person shorthand).';

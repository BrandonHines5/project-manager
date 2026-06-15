-- Project type drives client-facing branding. Residential jobs present under
-- Hines Homes; commercial jobs present under MJV Building Group. The colors
-- stay the same — only the name + logo shown to clients change — so we just
-- need to know which business a job belongs to.
--
-- Nullable: existing/unset projects fall back to the default (Hines Homes)
-- brand in the app layer.

do $$ begin
  create type project_type as enum (
    'residential_new',
    'residential_remodel',
    'commercial_new',
    'commercial_remodel'
  );
exception when duplicate_object then null; end $$;

alter table public.projects
  add column if not exists project_type project_type;

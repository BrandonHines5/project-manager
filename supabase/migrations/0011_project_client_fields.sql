-- Pull-from-dashboard plumbing.
-- Projects are now created on the dashboard side first (with the client's
-- contact info captured during sales). When staff starts the build in the
-- PM app, they pick the project from a dashboard-supplied list and the PM
-- creates its local row with the identity fields pre-filled.

alter table public.projects
  add column if not exists client_name text,
  add column if not exists client_email text,
  add column if not exists client_phone text,
  add column if not exists dashboard_pulled_at timestamptz;

comment on column public.projects.client_name is
  'Client display name. Source of truth is the dashboard; this is a mirror updated whenever we re-pull.';
comment on column public.projects.client_email is
  'Client primary email, mirrored from dashboard.';
comment on column public.projects.client_phone is
  'Client primary phone, mirrored from dashboard.';
comment on column public.projects.dashboard_pulled_at is
  'Set when this project was pulled in from the dashboard. NULL means it was created standalone in PM (transitional / edge case).';

-- Org-wide app settings as a tiny key/value table. First use: the default
-- disclaimer text appended to every change order / selection the client views
-- (key 'decision_disclaimer').
--
-- Readable by ALL authenticated users (clients must read the disclaimer under
-- their own session — the roles_read_all pattern from 0054); staff-only writes.

create table if not exists public.app_settings (
  key text primary key,
  value text,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null
);

create index if not exists idx_app_settings_updated_by on public.app_settings(updated_by);

drop trigger if exists trg_app_settings_updated_at on public.app_settings;
create trigger trg_app_settings_updated_at before update on public.app_settings
  for each row execute function public.touch_updated_at();

alter table public.app_settings enable row level security;

drop policy if exists app_settings_read_all on public.app_settings;
create policy app_settings_read_all on public.app_settings
  for select to authenticated using (true);

drop policy if exists app_settings_staff_write on public.app_settings;
create policy app_settings_staff_write on public.app_settings
  for all using (public.is_staff()) with check (public.is_staff());

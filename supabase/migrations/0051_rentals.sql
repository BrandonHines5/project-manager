-- Rentals tracker.
--
-- The warranty manager also tracks open issues at rental properties. Rentals
-- are NOT construction projects (some weren't built by us) and have no warranty
-- end date, so they get their own tables rather than reusing projects /
-- schedule_items. Property identity (address, tenant, owner) mirrors the CRM
-- `rentals` table; crm_rental_id links back for syncing.

create table if not exists public.rental_properties (
  id uuid primary key default gen_random_uuid(),
  crm_rental_id uuid unique,
  address text not null,
  tenant_name text,
  property_owner text,
  lease_status text,
  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.rental_items (
  id uuid primary key default gen_random_uuid(),
  rental_property_id uuid not null
    references public.rental_properties(id) on delete cascade,
  title text not null,
  resolution text,
  who_fixing text,
  date_noted date,
  due_date date,
  status schedule_item_status not null default 'not_started',
  no_action boolean not null default false,
  position int not null default 0,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_rental_items_property
  on public.rental_items(rental_property_id);

-- updated_at maintenance (reuses the shared trigger fn from 0001).
drop trigger if exists touch_rental_properties on public.rental_properties;
create trigger touch_rental_properties before update on public.rental_properties
  for each row execute function public.touch_updated_at();
drop trigger if exists touch_rental_items on public.rental_items;
create trigger touch_rental_items before update on public.rental_items
  for each row execute function public.touch_updated_at();

-- RLS: staff-only, like the rest of the internal tracker tables.
alter table public.rental_properties enable row level security;
alter table public.rental_items enable row level security;

create policy rental_properties_staff_all on public.rental_properties
  for all using (public.is_staff()) with check (public.is_staff());
create policy rental_items_staff_all on public.rental_items
  for all using (public.is_staff()) with check (public.is_staff());

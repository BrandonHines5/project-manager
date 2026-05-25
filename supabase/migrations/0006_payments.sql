do $$ begin
  create type payment_method as enum ('check', 'wire', 'card', 'cash', 'other');
exception when duplicate_object then null; end $$;

create table if not exists public.project_payments (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  amount numeric(14,2) not null,
  paid_on date not null default current_date,
  method payment_method not null default 'check',
  reference text,
  notes text,
  recorded_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists idx_pp_project on public.project_payments(project_id, paid_on desc);

alter table public.project_payments enable row level security;

drop policy if exists pp_staff_all on public.project_payments;
create policy pp_staff_all on public.project_payments
  for all using (public.is_staff()) with check (public.is_staff());

drop policy if exists pp_client_read on public.project_payments;
create policy pp_client_read on public.project_payments
  for select using (
    public.current_role_name() = 'client'
    and public.is_member_of_project(project_id)
  );

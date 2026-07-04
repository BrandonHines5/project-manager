-- Bid Requests module (BuilderTrend-style bid packages).
-- Staff draft a bid package (scope + cost-coded line items or flat fee),
-- send it to multiple sub/vendor companies, each of which gets an
-- unguessable access token used in a public /bid/{token} link (no login).
-- Subs price line items (or a flat total), decline, or comment. Staff
-- compare responses side-by-side and award — optionally auto-creating a
-- linked purchase order (see 0062).
--
-- Access model:
--   * Staff: full access (RLS *_staff_all).
--   * Trade users with logins: read-only rows for THEIR company only —
--     never competitors' bids or tokens. Mutations go through the same
--     tokenized server actions as anonymous subs.
--   * Anonymous subs: NO RLS policies at all. Token traffic is served
--     exclusively by the service-role client in server actions; the anon
--     key can never touch these tables.
--   * Clients: no access.

do $$ begin
  create type bid_package_status as enum ('draft', 'sent', 'awarded', 'closed');
exception when duplicate_object then null; end $$;

do $$ begin
  create type bid_recipient_status as enum ('invited', 'submitted', 'declined', 'awarded');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------

create table if not exists public.bid_packages (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  number int not null,
  title text not null,
  scope text,
  due_date date,
  -- Flat-fee mode: subs enter one total instead of pricing line items.
  flat_fee boolean not null default false,
  allow_multiple_awards boolean not null default false,
  status bid_package_status not null default 'draft',
  sent_at timestamptz,
  awarded_at timestamptz,
  closed_at timestamptz,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, number)
);
create index if not exists idx_bp_project on public.bid_packages(project_id, created_at desc);
create index if not exists idx_bp_status on public.bid_packages(project_id, status);
create index if not exists idx_bp_created_by on public.bid_packages(created_by);

drop trigger if exists trg_bid_packages_updated_at on public.bid_packages;
create trigger trg_bid_packages_updated_at before update on public.bid_packages
  for each row execute function public.touch_updated_at();

-- Line items define the pricing structure; the sub supplies unit costs via
-- bid_line_item_quotes. No unit_cost here on purpose.
create table if not exists public.bid_package_line_items (
  id uuid primary key default gen_random_uuid(),
  bid_package_id uuid not null references public.bid_packages(id) on delete cascade,
  cost_code_id uuid references public.cost_codes(id) on delete set null,
  description text not null,
  quantity numeric(14,4) not null default 1,
  unit text,
  position int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists idx_bpli_package on public.bid_package_line_items(bid_package_id, position);
create index if not exists idx_bpli_cost_code on public.bid_package_line_items(cost_code_id);

create table if not exists public.bid_package_attachments (
  id uuid primary key default gen_random_uuid(),
  bid_package_id uuid not null references public.bid_packages(id) on delete cascade,
  storage_bucket text not null default 'project-files',
  storage_path text not null,
  file_name text not null,
  file_type text,
  file_size bigint,
  caption text,
  position int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists idx_bpa_package on public.bid_package_attachments(bid_package_id);

-- One row per invited company. `token` is the sub's credential for the
-- public /bid/{token} page; nulled when bidding closes.
create table if not exists public.bid_recipients (
  id uuid primary key default gen_random_uuid(),
  bid_package_id uuid not null references public.bid_packages(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  token text unique,
  status bid_recipient_status not null default 'invited',
  -- Sub's total in flat-fee mode; denormalized sum of quotes in line mode.
  flat_total numeric(14,2),
  notes text,
  sent_to_email text,
  sent_to_phone text,
  last_sent_at timestamptz,
  viewed_at timestamptz,
  submitted_at timestamptz,
  awarded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (bid_package_id, company_id)
);
create index if not exists idx_br_package on public.bid_recipients(bid_package_id);
create index if not exists idx_br_company on public.bid_recipients(company_id);

drop trigger if exists trg_bid_recipients_updated_at on public.bid_recipients;
create trigger trg_bid_recipients_updated_at before update on public.bid_recipients
  for each row execute function public.touch_updated_at();

create table if not exists public.bid_line_item_quotes (
  id uuid primary key default gen_random_uuid(),
  bid_recipient_id uuid not null references public.bid_recipients(id) on delete cascade,
  line_item_id uuid not null references public.bid_package_line_items(id) on delete cascade,
  unit_cost numeric(14,2) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (bid_recipient_id, line_item_id)
);
create index if not exists idx_bliq_line_item on public.bid_line_item_quotes(line_item_id);

drop trigger if exists trg_bid_line_item_quotes_updated_at on public.bid_line_item_quotes;
create trigger trg_bid_line_item_quotes_updated_at before update on public.bid_line_item_quotes
  for each row execute function public.touch_updated_at();

-- Per-recipient comment thread (staff ↔ that sub only, never cross-sub).
-- author_profile_id null = written via the public token page; author_name
-- snapshots the display name either way.
create table if not exists public.bid_comments (
  id uuid primary key default gen_random_uuid(),
  bid_recipient_id uuid not null references public.bid_recipients(id) on delete cascade,
  author_profile_id uuid references public.profiles(id) on delete set null,
  author_name text not null,
  body text not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_bc_recipient on public.bid_comments(bid_recipient_id, created_at);
create index if not exists idx_bc_author on public.bid_comments(author_profile_id);

-- ---------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------

-- Company of the logged-in user (trade portal RLS). SECURITY DEFINER so the
-- profiles lookup doesn't recurse through profiles RLS.
create or replace function public.current_company_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select company_id from public.profiles where id = auth.uid();
$$;
grant execute on function public.current_company_id() to authenticated;

-- Per-project sequential bid numbers. Same advisory-lock pattern as
-- next_decision_number (0009); second hash arg 1 keeps the lock keyspace
-- distinct from decisions (0) and purchase orders (2).
create or replace function public.next_bid_package_number(p_project uuid)
returns int
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  next_num int;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_project::text, 1));
  select coalesce(max(number), 0) + 1
    into next_num
    from public.bid_packages
    where project_id = p_project;
  return next_num;
end $fn$;
grant execute on function public.next_bid_package_number(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------

alter table public.bid_packages           enable row level security;
alter table public.bid_package_line_items enable row level security;
alter table public.bid_package_attachments enable row level security;
alter table public.bid_recipients         enable row level security;
alter table public.bid_line_item_quotes   enable row level security;
alter table public.bid_comments           enable row level security;

drop policy if exists bp_staff_all on public.bid_packages;
create policy bp_staff_all on public.bid_packages
  for all using (public.is_staff()) with check (public.is_staff());

-- Trade users see packages their company was invited to, once released.
drop policy if exists bp_trade_read on public.bid_packages;
create policy bp_trade_read on public.bid_packages
  for select using (
    public.current_role_name() = 'trade'
    and status <> 'draft'
    and exists (
      select 1 from public.bid_recipients br
      where br.bid_package_id = bid_packages.id
        and br.company_id = public.current_company_id()
    )
  );

drop policy if exists bpli_staff_all on public.bid_package_line_items;
create policy bpli_staff_all on public.bid_package_line_items
  for all using (public.is_staff()) with check (public.is_staff());

drop policy if exists bpli_trade_read on public.bid_package_line_items;
create policy bpli_trade_read on public.bid_package_line_items
  for select using (
    public.current_role_name() = 'trade'
    and exists (
      select 1
      from public.bid_recipients br
      join public.bid_packages bp on bp.id = br.bid_package_id
      where br.bid_package_id = bid_package_line_items.bid_package_id
        and br.company_id = public.current_company_id()
        and bp.status <> 'draft'
    )
  );

drop policy if exists bpa_staff_all on public.bid_package_attachments;
create policy bpa_staff_all on public.bid_package_attachments
  for all using (public.is_staff()) with check (public.is_staff());

drop policy if exists bpa_trade_read on public.bid_package_attachments;
create policy bpa_trade_read on public.bid_package_attachments
  for select using (
    public.current_role_name() = 'trade'
    and exists (
      select 1
      from public.bid_recipients br
      join public.bid_packages bp on bp.id = br.bid_package_id
      where br.bid_package_id = bid_package_attachments.bid_package_id
        and br.company_id = public.current_company_id()
        and bp.status <> 'draft'
    )
  );

drop policy if exists br_staff_all on public.bid_recipients;
create policy br_staff_all on public.bid_recipients
  for all using (public.is_staff()) with check (public.is_staff());

-- A trade reads ONLY their own company's recipient row (their token is
-- their credential for the public page; competitors' rows stay invisible).
drop policy if exists br_trade_read on public.bid_recipients;
create policy br_trade_read on public.bid_recipients
  for select using (
    public.current_role_name() = 'trade'
    and company_id = public.current_company_id()
  );

drop policy if exists bliq_staff_all on public.bid_line_item_quotes;
create policy bliq_staff_all on public.bid_line_item_quotes
  for all using (public.is_staff()) with check (public.is_staff());

drop policy if exists bliq_trade_read on public.bid_line_item_quotes;
create policy bliq_trade_read on public.bid_line_item_quotes
  for select using (
    public.current_role_name() = 'trade'
    and exists (
      select 1 from public.bid_recipients br
      where br.id = bid_line_item_quotes.bid_recipient_id
        and br.company_id = public.current_company_id()
    )
  );

drop policy if exists bc_staff_all on public.bid_comments;
create policy bc_staff_all on public.bid_comments
  for all using (public.is_staff()) with check (public.is_staff());

drop policy if exists bc_trade_read on public.bid_comments;
create policy bc_trade_read on public.bid_comments
  for select using (
    public.current_role_name() = 'trade'
    and exists (
      select 1 from public.bid_recipients br
      where br.id = bid_comments.bid_recipient_id
        and br.company_id = public.current_company_id()
    )
  );

drop policy if exists bc_trade_insert on public.bid_comments;
create policy bc_trade_insert on public.bid_comments
  for insert with check (
    public.current_role_name() = 'trade'
    and author_profile_id = auth.uid()
    and exists (
      select 1 from public.bid_recipients br
      where br.id = bid_comments.bid_recipient_id
        and br.company_id = public.current_company_id()
    )
  );

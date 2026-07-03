-- Purchase Orders module (BuilderTrend-style, v1 without payments/bills).
-- Staff draft a cost-coded PO for a sub/vendor, release it (email/SMS with a
-- tokenized public /po/{token} link), and the sub approves with a typed
-- signature + disclaimer or declines. Staff can approve on the sub's behalf,
-- unrelease to revise, void, and flag work complete. Approved POs roll up
-- into committed costs by cost code on the Pricing tab.
--
-- Same access model as bid packages (0060): staff full access, trade users
-- read their own company's POs once released, anonymous token traffic is
-- service-role only, clients have no access.

do $$ begin
  create type po_status as enum ('draft', 'released', 'approved', 'declined', 'void');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------

create table if not exists public.purchase_orders (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  number int not null,
  -- Optional external/custom PO number shown alongside the sequential one.
  custom_number text,
  title text not null,
  scope text,
  company_id uuid not null references public.companies(id) on delete restrict,
  status po_status not null default 'draft',
  approval_deadline date,
  -- Flat-fee mode: one total, no line items.
  flat_fee boolean not null default false,
  flat_total numeric(14,2),
  -- Set when this PO was created by awarding a bid.
  source_bid_recipient_id uuid references public.bid_recipients(id) on delete set null,
  -- Sub's credential for the public /po/{token} page. Generated at release,
  -- nulled on unrelease/void (revocation).
  token text unique,
  released_at timestamptz,
  approved_at timestamptz,
  approved_signature text,
  -- Null = sub approved via token page; set = staff approved on behalf.
  approved_by_profile_id uuid references public.profiles(id) on delete set null,
  declined_at timestamptz,
  decline_reason text,
  work_complete boolean not null default false,
  work_complete_at timestamptz,
  voided_at timestamptz,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, number)
);
create index if not exists idx_po_project on public.purchase_orders(project_id, created_at desc);
create index if not exists idx_po_status on public.purchase_orders(project_id, status);
create index if not exists idx_po_company on public.purchase_orders(company_id);
create index if not exists idx_po_source_bid on public.purchase_orders(source_bid_recipient_id);
create index if not exists idx_po_created_by on public.purchase_orders(created_by);
create index if not exists idx_po_approved_by on public.purchase_orders(approved_by_profile_id);

drop trigger if exists trg_purchase_orders_updated_at on public.purchase_orders;
create trigger trg_purchase_orders_updated_at before update on public.purchase_orders
  for each row execute function public.touch_updated_at();

create table if not exists public.po_line_items (
  id uuid primary key default gen_random_uuid(),
  purchase_order_id uuid not null references public.purchase_orders(id) on delete cascade,
  cost_code_id uuid references public.cost_codes(id) on delete set null,
  description text not null,
  quantity numeric(14,4) not null default 1,
  unit text,
  unit_cost numeric(14,2) not null default 0,
  position int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists idx_poli_po on public.po_line_items(purchase_order_id, position);
create index if not exists idx_poli_cost_code on public.po_line_items(cost_code_id);

create table if not exists public.po_attachments (
  id uuid primary key default gen_random_uuid(),
  purchase_order_id uuid not null references public.purchase_orders(id) on delete cascade,
  storage_bucket text not null default 'project-files',
  storage_path text not null,
  file_name text not null,
  file_type text,
  file_size bigint,
  caption text,
  position int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists idx_poa_po on public.po_attachments(purchase_order_id);

-- Staff ↔ sub comment thread. author_profile_id null = token page author.
create table if not exists public.po_comments (
  id uuid primary key default gen_random_uuid(),
  purchase_order_id uuid not null references public.purchase_orders(id) on delete cascade,
  author_profile_id uuid references public.profiles(id) on delete set null,
  author_name text not null,
  body text not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_poc_po on public.po_comments(purchase_order_id, created_at);
create index if not exists idx_poc_author on public.po_comments(author_profile_id);

-- ---------------------------------------------------------------------
-- Numbering
-- ---------------------------------------------------------------------

-- Advisory-lock second arg 2 = purchase orders (0 decisions, 1 bid packages).
-- award_bid below allocates numbers under the SAME lock key so awards and
-- manual PO creation can't collide.
create or replace function public.next_po_number(p_project uuid)
returns int
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  next_num int;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_project::text, 2));
  select coalesce(max(number), 0) + 1
    into next_num
    from public.purchase_orders
    where project_id = p_project;
  return next_num;
end $fn$;
grant execute on function public.next_po_number(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- Atomic award
-- ---------------------------------------------------------------------

-- Awards a bid to one recipient and (optionally) creates a draft PO
-- pre-filled from the package's line items joined to the winner's quotes.
-- One transaction: recipient → awarded, package → awarded (unless
-- allow_multiple_awards keeps it open for more), PO insert + line copy.
-- Emails/notifications are the caller's job afterward.
create or replace function public.award_bid(p_recipient uuid, p_create_po boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  r public.bid_recipients%rowtype;
  pkg public.bid_packages%rowtype;
  v_po_id uuid;
  v_po_number int;
begin
  if not public.is_staff() then
    raise exception 'staff only';
  end if;

  select * into r from public.bid_recipients where id = p_recipient for update;
  if not found then
    raise exception 'bid recipient not found';
  end if;
  if r.status <> 'submitted' then
    raise exception 'only a submitted bid can be awarded (current status: %)', r.status;
  end if;

  select * into pkg from public.bid_packages where id = r.bid_package_id for update;
  if pkg.status not in ('sent', 'awarded') then
    raise exception 'bid package is not open (current status: %)', pkg.status;
  end if;
  if pkg.status = 'awarded' and not pkg.allow_multiple_awards then
    raise exception 'this package has already been awarded';
  end if;

  update public.bid_recipients
    set status = 'awarded', awarded_at = now()
    where id = p_recipient;

  update public.bid_packages
    set status = 'awarded', awarded_at = coalesce(awarded_at, now())
    where id = pkg.id;

  if p_create_po then
    -- Same advisory-lock key as next_po_number (arg 2).
    perform pg_advisory_xact_lock(hashtextextended(pkg.project_id::text, 2));
    select coalesce(max(number), 0) + 1
      into v_po_number
      from public.purchase_orders
      where project_id = pkg.project_id;

    insert into public.purchase_orders
      (project_id, number, title, scope, company_id, status,
       flat_fee, flat_total, source_bid_recipient_id, created_by)
    values
      (pkg.project_id, v_po_number, pkg.title, pkg.scope, r.company_id, 'draft',
       pkg.flat_fee, case when pkg.flat_fee then r.flat_total end, r.id, auth.uid())
    returning id into v_po_id;

    if not pkg.flat_fee then
      insert into public.po_line_items
        (purchase_order_id, cost_code_id, description, quantity, unit, unit_cost, position)
      select v_po_id, li.cost_code_id, li.description, li.quantity, li.unit,
             coalesce(q.unit_cost, 0), li.position
      from public.bid_package_line_items li
      left join public.bid_line_item_quotes q
        on q.line_item_id = li.id and q.bid_recipient_id = r.id
      where li.bid_package_id = pkg.id
      order by li.position;
    end if;
  end if;

  return jsonb_build_object('po_id', v_po_id, 'po_number', v_po_number);
end $fn$;
grant execute on function public.award_bid(uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------

alter table public.purchase_orders enable row level security;
alter table public.po_line_items   enable row level security;
alter table public.po_attachments  enable row level security;
alter table public.po_comments     enable row level security;

drop policy if exists po_staff_all on public.purchase_orders;
create policy po_staff_all on public.purchase_orders
  for all using (public.is_staff()) with check (public.is_staff());

drop policy if exists po_trade_read on public.purchase_orders;
create policy po_trade_read on public.purchase_orders
  for select using (
    public.current_role_name() = 'trade'
    and status <> 'draft'
    and company_id = public.current_company_id()
  );

drop policy if exists poli_staff_all on public.po_line_items;
create policy poli_staff_all on public.po_line_items
  for all using (public.is_staff()) with check (public.is_staff());

drop policy if exists poli_trade_read on public.po_line_items;
create policy poli_trade_read on public.po_line_items
  for select using (
    public.current_role_name() = 'trade'
    and exists (
      select 1 from public.purchase_orders po
      where po.id = po_line_items.purchase_order_id
        and po.status <> 'draft'
        and po.company_id = public.current_company_id()
    )
  );

drop policy if exists poa_staff_all on public.po_attachments;
create policy poa_staff_all on public.po_attachments
  for all using (public.is_staff()) with check (public.is_staff());

drop policy if exists poa_trade_read on public.po_attachments;
create policy poa_trade_read on public.po_attachments
  for select using (
    public.current_role_name() = 'trade'
    and exists (
      select 1 from public.purchase_orders po
      where po.id = po_attachments.purchase_order_id
        and po.status <> 'draft'
        and po.company_id = public.current_company_id()
    )
  );

drop policy if exists poc_staff_all on public.po_comments;
create policy poc_staff_all on public.po_comments
  for all using (public.is_staff()) with check (public.is_staff());

drop policy if exists poc_trade_read on public.po_comments;
create policy poc_trade_read on public.po_comments
  for select using (
    public.current_role_name() = 'trade'
    and exists (
      select 1 from public.purchase_orders po
      where po.id = po_comments.purchase_order_id
        and po.status <> 'draft'
        and po.company_id = public.current_company_id()
    )
  );

drop policy if exists poc_trade_insert on public.po_comments;
create policy poc_trade_insert on public.po_comments
  for insert with check (
    public.current_role_name() = 'trade'
    and author_profile_id = auth.uid()
    and exists (
      select 1 from public.purchase_orders po
      where po.id = po_comments.purchase_order_id
        and po.status <> 'draft'
        and po.company_id = public.current_company_id()
    )
  );

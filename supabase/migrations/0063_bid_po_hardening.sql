-- Hardening pass from PR #97 review (CodeRabbit).
--
-- 1. Staff-only guards on the numbering RPCs. Both are SECURITY DEFINER and
--    bypass RLS; only staff server actions ever call them, so reject other
--    authenticated callers (a trade/client could otherwise probe per-project
--    bid/PO counts).
-- 2. Non-negative checks on the two monetary columns written from anonymous
--    token input. PO-side columns stay unconstrained on purpose — staff enter
--    those, and negative line items (credits/backcharges) are legitimate.

create or replace function public.next_bid_package_number(p_project uuid)
returns int
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  next_num int;
begin
  if not public.is_staff() then
    raise exception 'staff only';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_project::text, 1));
  select coalesce(max(number), 0) + 1
    into next_num
    from public.bid_packages
    where project_id = p_project;
  return next_num;
end $fn$;

create or replace function public.next_po_number(p_project uuid)
returns int
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  next_num int;
begin
  if not public.is_staff() then
    raise exception 'staff only';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_project::text, 2));
  select coalesce(max(number), 0) + 1
    into next_num
    from public.purchase_orders
    where project_id = p_project;
  return next_num;
end $fn$;

do $$ begin
  alter table public.bid_line_item_quotes
    add constraint bliq_unit_cost_nonneg check (unit_cost >= 0);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.bid_recipients
    add constraint br_flat_total_nonneg check (flat_total is null or flat_total >= 0);
exception when duplicate_object then null; end $$;

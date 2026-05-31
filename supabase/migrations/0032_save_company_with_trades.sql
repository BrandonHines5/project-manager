-- CodeRabbit caught two issues from migration 0026:
--
-- (1) The saveCompany action does the company write and the company_trades
--     delete/insert in separate statements. If the trades insert fails
--     after the delete succeeded, the company is left with NO trades —
--     partial state that a user has to notice and fix by hand. Wrap the
--     three writes in a single Postgres function so they share a
--     transaction and roll back together.
--
-- (2) The company_trades SELECT policy was `using (true)`, which let any
--     authenticated role read every company's trades. Tighten to
--     staff-only — the only contexts that actually display trades (the
--     Companies page and the assignment pickers in the schedule dialog)
--     are staff-only routes anyway.

drop policy if exists company_trades_read_all on public.company_trades;
create policy company_trades_read_all on public.company_trades
  for select using (public.is_staff());

-- save_company_with_trades(id, name, type, address, phone, email, notes,
--                          trades)
-- Returns the (possibly new) company id. Trades array must be
-- already-normalized (lower-cased, trimmed, ≤20, ≤60 chars each). The
-- function still defends with the same shape check via the existing
-- table trigger that fires on company_trades writes, but extra rejection
-- here lets callers fail fast with a clear message before any write.

create or replace function public.save_company_with_trades(
  p_id uuid,
  p_name text,
  p_type public.company_type,
  p_address text,
  p_phone text,
  p_email text,
  p_notes text,
  p_trades text[]
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid := p_id;
  v_first_trade text := null;
begin
  if not public.is_staff() then
    raise exception 'only staff may save companies';
  end if;

  if array_length(p_trades, 1) is null then
    p_trades := array[]::text[];
  end if;
  if array_length(p_trades, 1) > 20 then
    raise exception 'at most 20 trades per company';
  end if;
  if array_length(p_trades, 1) is not null then
    v_first_trade := p_trades[1];
  end if;

  if v_id is null then
    insert into public.companies (name, type, address, phone, email, notes, trade_category)
    values (p_name, p_type, p_address, p_phone, p_email, p_notes, v_first_trade)
    returning id into v_id;
  else
    update public.companies
      set name = p_name,
          type = p_type,
          address = p_address,
          phone = p_phone,
          email = p_email,
          notes = p_notes,
          trade_category = v_first_trade
      where id = v_id;
    if not found then
      raise exception 'company not found';
    end if;
  end if;

  -- Replace the full trade set atomically. Because we're inside a single
  -- plpgsql function body, the delete + insert share a transaction; a
  -- failure on the insert rolls back the delete (and the company write).
  delete from public.company_trades where company_id = v_id;
  if array_length(p_trades, 1) is not null then
    insert into public.company_trades (company_id, trade)
    select v_id, unnest(p_trades);
  end if;

  return v_id;
end;
$$;

revoke execute on function public.save_company_with_trades(uuid, text, public.company_type, text, text, text, text, text[]) from public, anon;
grant execute on function public.save_company_with_trades(uuid, text, public.company_type, text, text, text, text, text[]) to authenticated;

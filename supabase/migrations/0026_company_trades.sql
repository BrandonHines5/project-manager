-- A company can do more than one trade. The existing `trade_category` text
-- column captures one tag (sometimes a comma-separated list, sometimes
-- free-text); add a real many-to-many junction so we can:
--   - chip-style multi-tag editing
--   - "framers available" filtering on the assignment picker
--   - "which sub does X" lookups across projects without text matching
--
-- The `trade` is free-text (not enum) because every builder has a handful of
-- bespoke tags (e.g. "Decorative tile", "Custom millwork") that don't fit a
-- canonical list. Normalize to lower-case to avoid duplicates ("Framing" vs
-- "framing" vs "FRAMING").

create table if not exists public.company_trades (
  company_id uuid not null references public.companies(id) on delete cascade,
  trade text not null check (
    char_length(trade) between 1 and 60
    and trade = lower(trade)
    and trim(trade) = trade
  ),
  created_at timestamptz not null default now(),
  primary key (company_id, trade)
);
create index if not exists idx_company_trades_trade
  on public.company_trades(trade);

alter table public.company_trades enable row level security;

drop policy if exists company_trades_read_all on public.company_trades;
create policy company_trades_read_all on public.company_trades
  for select using (true);

drop policy if exists company_trades_staff_all on public.company_trades;
create policy company_trades_staff_all on public.company_trades
  for all using (public.is_staff()) with check (public.is_staff());

-- Backfill from the existing `trade_category` text column. The column is
-- sometimes a single tag, sometimes a comma-separated list; split on commas
-- and trim. Lowercased to fit the check constraint above. Empty results
-- (NULL trade_category) get no rows.

do $$
declare
  v_row record;
  v_tag text;
begin
  for v_row in select id, trade_category from public.companies where trade_category is not null loop
    foreach v_tag in array string_to_array(v_row.trade_category, ',') loop
      v_tag := lower(trim(v_tag));
      continue when v_tag = '' or char_length(v_tag) > 60;
      insert into public.company_trades (company_id, trade)
      values (v_row.id, v_tag)
      on conflict do nothing;
    end loop;
  end loop;
end $$;

-- Make schedule delay reasons staff-editable.
--
-- schedule_delays.reason_category was a fixed enum (delay_reason: weather, sub,
-- material, owner_decision, permit, other). To let staff add / rename / remove
-- reasons from Settings, convert the column to plain text and keep the curated
-- list in app_settings (key 'delay_reasons'). Existing rows keep their values
-- verbatim, so this is backward compatible with code that reads the string.

-- ---------------------------------------------------------------------------
-- 1. Column type: enum -> text (idempotent)
-- ---------------------------------------------------------------------------
do $$
begin
  if (
    select data_type
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'schedule_delays'
      and column_name = 'reason_category'
  ) <> 'text' then
    alter table public.schedule_delays
      alter column reason_category type text using reason_category::text;
  end if;
end $$;

-- Reason must stay non-empty (the app validates against the configured list;
-- this is just a floor).
do $$
begin
  alter table public.schedule_delays
    add constraint schedule_delays_reason_not_empty
    check (btrim(reason_category) <> '');
exception
  when duplicate_object then null;
end $$;

-- The enum type (public.delay_reason) is intentionally left in place — it is
-- harmless once unreferenced and dropping it isn't necessary.

-- ---------------------------------------------------------------------------
-- 2. Seed the editable list with the original six reasons
-- ---------------------------------------------------------------------------
insert into public.app_settings (key, value)
values (
  'delay_reasons',
  '[{"value":"weather","label":"Weather"},{"value":"sub","label":"Subcontractor"},{"value":"material","label":"Material"},{"value":"owner_decision","label":"Owner decision"},{"value":"permit","label":"Permit"},{"value":"other","label":"Other"}]'
)
on conflict (key) do nothing;

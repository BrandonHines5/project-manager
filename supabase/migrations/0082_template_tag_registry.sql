-- Template-tag registry helpers for Settings → Template tags.
--
--   template_tag_usage()  – distinct base tags across schedule_items +
--                           decisions with usage counts. Runs in the database
--                           so the settings screen lists EVERY tag that exists
--                           instead of a client-side select that PostgREST
--                           caps at 1000 rows (which silently dropped tags).
--   strip_template_tag()  – removes a tag (both the positive and the negated
--                           "!" form) from every schedule_item / decision, so
--                           "remove tag" in settings actually deletes it rather
--                           than leaving it on items where it still filters
--                           copies and shows as a schedule chip.
--
-- Both run SECURITY INVOKER so table RLS still applies (staff read/modify all
-- rows; anyone else only their own). strip additionally guards on is_staff().

create or replace function public.template_tag_usage()
returns table (tag text, uses bigint)
language sql
stable
security invoker
set search_path = public
as $$
  with all_tags as (
    select unnest(template_tags) as t from public.schedule_items
    union all
    select unnest(template_tags) as t from public.decisions
  )
  select lower(regexp_replace(t, '^!', '')) as tag, count(*) as uses
  from all_tags
  group by 1
  order by 1;
$$;

create or replace function public.strip_template_tag(p_tag text)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_base text := lower(regexp_replace(p_tag, '^!', ''));
  v_variants text[] := array[v_base, '!' || v_base];
  v_total integer := 0;
  v_n integer;
begin
  if not public.is_staff() then
    raise exception 'Only staff may modify template tags';
  end if;

  update public.schedule_items
    set template_tags = coalesce((
      select array_agg(x)
      from unnest(template_tags) as x
      where lower(regexp_replace(x, '^!', '')) <> v_base
    ), array[]::text[])
  where template_tags && v_variants;
  get diagnostics v_n = row_count;
  v_total := v_total + v_n;

  update public.decisions
    set template_tags = coalesce((
      select array_agg(x)
      from unnest(template_tags) as x
      where lower(regexp_replace(x, '^!', '')) <> v_base
    ), array[]::text[])
  where template_tags && v_variants;
  get diagnostics v_n = row_count;
  v_total := v_total + v_n;

  return v_total;
end;
$$;

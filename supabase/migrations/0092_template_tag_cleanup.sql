-- =====================================================================
-- 0092 — Template-tag cleanup: permit_required → in_city, merge stonebrook
-- =====================================================================
-- Data fix requested by Brandon:
--   * "In_City and Permit mean the same thing" — every `permit_required`
--     tag becomes `in_city` (negated `!permit_required` → `!in_city`), on
--     the Template and every job, then permit_required ceases to exist.
--     The Settings tag list is derived from usage (template_tag_usage()),
--     so once no rows carry it the tag disappears from the registry.
--   * "Stonebrook duplicated" — the questionnaire showed two Stonebrook
--     questions because both `stonebrook` and `stonebrook_or_quarters_lot`
--     exist. The latter (one template item) merges into `stonebrook`.
--   * `projects.attributes` answer keys are renamed the same way; when a
--     project answered BOTH keys, the merged answer is the logical OR
--     (they mean the same thing, so "yes" on either means yes).

-- ----- schedule_items + decisions tag arrays --------------------------
update public.schedule_items
set template_tags = (
  select coalesce(array_agg(distinct mapped), array[]::text[])
  from (
    select case x
      when 'permit_required' then 'in_city'
      when '!permit_required' then '!in_city'
      when 'stonebrook_or_quarters_lot' then 'stonebrook'
      when '!stonebrook_or_quarters_lot' then '!stonebrook'
      else x
    end as mapped
    from unnest(template_tags) as x
  ) t
)
where template_tags && array[
  'permit_required', '!permit_required',
  'stonebrook_or_quarters_lot', '!stonebrook_or_quarters_lot'
];

update public.decisions
set template_tags = (
  select coalesce(array_agg(distinct mapped), array[]::text[])
  from (
    select case x
      when 'permit_required' then 'in_city'
      when '!permit_required' then '!in_city'
      when 'stonebrook_or_quarters_lot' then 'stonebrook'
      when '!stonebrook_or_quarters_lot' then '!stonebrook'
      else x
    end as mapped
    from unnest(template_tags) as x
  ) t
)
where template_tags && array[
  'permit_required', '!permit_required',
  'stonebrook_or_quarters_lot', '!stonebrook_or_quarters_lot'
];

-- ----- projects.attributes answer keys --------------------------------
update public.projects
set attributes = (
  (attributes - 'permit_required' - 'stonebrook_or_quarters_lot')
  || case
       when attributes ? 'permit_required' or attributes ? 'in_city' then
         jsonb_build_object(
           'in_city',
           coalesce((attributes ->> 'in_city')::boolean, false)
             or coalesce((attributes ->> 'permit_required')::boolean, false)
         )
       else '{}'::jsonb
     end
  || case
       when attributes ? 'stonebrook_or_quarters_lot' or attributes ? 'stonebrook' then
         jsonb_build_object(
           'stonebrook',
           coalesce((attributes ->> 'stonebrook')::boolean, false)
             or coalesce((attributes ->> 'stonebrook_or_quarters_lot')::boolean, false)
         )
       else '{}'::jsonb
     end
)
where attributes ?| array['permit_required', 'stonebrook_or_quarters_lot'];

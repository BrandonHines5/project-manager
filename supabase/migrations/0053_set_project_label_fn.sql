-- Atomic bulk add/remove of a single project label.
--
-- The sidebar's "Tag / Untag as Test" multi-select calls setProjectLabel().
-- Doing that as a read-modify-write per row (select labels → rewrite array →
-- update) is non-atomic — two concurrent edits to the same project can clobber
-- each other — and turns a large selection into one write per row.
--
-- This function applies the change in a single UPDATE using array_append /
-- array_remove, so every matched row mutates atomically and the whole batch is
-- one round trip. The WHERE guard skips rows already in the desired state, so:
--   * add never duplicates a label (only appends where it's absent), and
--   * the returned count reflects only rows that actually changed.
--
-- SECURITY INVOKER (the default) so the caller's RLS still decides which
-- projects they may touch — the app-layer requireStaff() is just a UX gate.

create or replace function public.set_project_label(
  p_ids uuid[],
  p_label text,
  p_add boolean
)
returns integer
language sql
security invoker
set search_path = ''
as $$
  with updated as (
    update public.projects as p
    set labels = case
      when p_add then array_append(p.labels, p_label)
      else array_remove(p.labels, p_label)
    end
    where p.id = any (p_ids)
      and (
        (p_add and not (p.labels @> array[p_label]))
        or ((not p_add) and (p.labels @> array[p_label]))
      )
    returning 1
  )
  select coalesce(count(*), 0)::int from updated;
$$;

revoke all on function public.set_project_label(uuid[], text, boolean) from public;
grant execute on function public.set_project_label(uuid[], text, boolean) to authenticated;

-- Decision due dates linked to schedule items.
--
-- A selection / change order's due date can now be tied to a schedule item
-- instead of a fixed date: "due 14 days before Cabinet Install starts". The
-- recipe is the same anchor triple follow-up templates use (0035): schedule
-- item + start/end + signed day offset.
--
-- `due_date` stays canonical (denormalized) so every consumer — list views,
-- the client portal, approval emails, the dashboard webhook — keeps reading
-- one column. The anchor fields are just the recipe used to refresh it:
--   - saveDecision computes due_date from the anchor at save time;
--   - the trigger below recomputes it whenever the anchor item's dates move
--     (covers manual moves, predecessor cascades, bulk shifts, and the AI
--     apply path in one choke point);
--   - deleting the anchor item unlinks the decision, freezing the last
--     computed due_date in place.

alter table public.decisions
  add column if not exists due_anchor_schedule_item_id uuid
    references public.schedule_items(id) on delete set null,
  add column if not exists due_anchor public.schedule_parent_anchor,
  add column if not exists due_anchor_offset_days int;

comment on column public.decisions.due_anchor_schedule_item_id is
  'When set, due_date follows this schedule item (see due_anchor / due_anchor_offset_days). Kept fresh by trg_si_decision_due_refresh.';

-- Cover the FK so schedule-item deletes don't seq-scan decisions, and the
-- refresh trigger's lookup stays an index hit.
create index if not exists idx_decisions_due_anchor_si
  on public.decisions(due_anchor_schedule_item_id)
  where due_anchor_schedule_item_id is not null;

-- Anchor triple is all-or-nothing, mirroring dft_anchor_triple_chk (0035).
alter table public.decisions
  drop constraint if exists decisions_due_anchor_triple_chk;
alter table public.decisions
  add constraint decisions_due_anchor_triple_chk
  check (
    (due_anchor_schedule_item_id is null and due_anchor is null
      and due_anchor_offset_days is null)
    or (due_anchor_schedule_item_id is not null and due_anchor is not null
      and due_anchor_offset_days is not null)
  );

-- ---------------------------------------------------------------------------
-- Keep linked due dates fresh / unlink on delete
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER: the refresh must succeed no matter which session moved
-- the schedule item (staff action, admin-client path, a future RPC), so it
-- can't depend on the caller's decisions RLS. search_path is pinned and all
-- references are schema-qualified.
create or replace function public.sync_decision_due_anchors()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    -- Unlink decisions pointing at the doomed item, freezing the last
    -- computed due_date. Clearing the whole triple BEFORE the row goes away
    -- matters: the FK's ON DELETE SET NULL would only null the id column,
    -- which the all-or-nothing check constraint rejects.
    update public.decisions
       set due_anchor_schedule_item_id = null,
           due_anchor = null,
           due_anchor_offset_days = null
     where due_anchor_schedule_item_id = old.id;
    -- Same latent problem exists for follow-up templates (0035): their FK is
    -- SET NULL under the same style of triple constraint, so deleting an
    -- anchored item used to fail outright. Clear those too — the template
    -- falls back to its fixed "days after approval" offset.
    update public.decision_followup_templates
       set anchor_schedule_item_id = null,
           parent_anchor = null,
           parent_offset_days = null
     where anchor_schedule_item_id = old.id;
    return old;
  end if;
  -- UPDATE (dates changed — see trigger WHEN clause): recompute due_date for
  -- every decision linked to this item. A null basis date yields a null
  -- due_date, matching how follow-up materialization treats undated anchors.
  update public.decisions d
     set due_date = case
           when d.due_anchor = 'start'
             then new.start_date + d.due_anchor_offset_days
           else new.end_date + d.due_anchor_offset_days
         end
   where d.due_anchor_schedule_item_id = new.id;
  return new;
end $$;

revoke execute on function public.sync_decision_due_anchors() from public, anon, authenticated;

drop trigger if exists trg_si_decision_due_unlink on public.schedule_items;
create trigger trg_si_decision_due_unlink
  before delete on public.schedule_items
  for each row execute function public.sync_decision_due_anchors();

drop trigger if exists trg_si_decision_due_refresh on public.schedule_items;
create trigger trg_si_decision_due_refresh
  after update on public.schedule_items
  for each row
  when (old.start_date is distinct from new.start_date
     or old.end_date is distinct from new.end_date)
  execute function public.sync_decision_due_anchors();

-- Tighten allowance invariants on the schema.
--
-- 1. Reject negative allowance budgets — a negative value would invert the
--    variance math in client_decide_decision and let a "budget" act as an
--    extra charge.
--
-- 2. Make decision_cost_items.choice_id agree with decision_id. The original
--    single-column FK only proved the choice existed somewhere, not that it
--    belonged to the same decision. Switch to a composite FK so a line item
--    cannot be attached to another decision's choice. Requires a
--    (id, decision_id) unique constraint on decision_choices for the FK
--    target.

alter table public.decisions
  drop constraint if exists decisions_allowance_amount_nonneg_chk,
  add constraint decisions_allowance_amount_nonneg_chk
    check (allowance_amount is null or allowance_amount >= 0);

-- Required for the composite FK target. id is already unique on its own, so
-- the data invariant is unchanged; this just exposes (id, decision_id) as a
-- referenceable key for foreign keys.
alter table public.decision_choices
  drop constraint if exists decision_choices_id_decision_id_key,
  add constraint decision_choices_id_decision_id_key
    unique (id, decision_id);

-- Replace the single-column FK with a composite one. We drop the auto-named
-- FK created in 0017 (decision_cost_items_choice_id_fkey is the default
-- Postgres convention) and add the new constraint that ties choice_id to the
-- same decision_id as the parent row.
alter table public.decision_cost_items
  drop constraint if exists decision_cost_items_choice_id_fkey,
  add constraint decision_cost_items_choice_matches_decision_fkey
    foreign key (choice_id, decision_id)
    references public.decision_choices(id, decision_id)
    on delete cascade;

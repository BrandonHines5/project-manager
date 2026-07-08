-- Backfill cost_delta / selected_choice_id for approved SELECTIONS that were
-- approved directly by staff before the app recorded which choice was chosen.
--
-- Historically only the client-approval RPC (client_decide_decision) set
-- selected_choice_id, so a staff "Approve" on a selection left BOTH
-- selected_choice_id and cost_delta null — the chosen option's cost never
-- reached the Pricing tab's "Approved decisions" rollup. saveDecision now
-- resolves the chosen choice on a staff-direct approval (explicit pick, the
-- client's prior pick, or auto-select when there's exactly one option); this
-- migration repairs the rows already stranded by the old behaviour.
--
-- We only auto-resolve the unambiguous single-choice case. Multi-choice
-- selections can't be resolved without knowing which option was chosen, so
-- they're intentionally left untouched — staff re-approve them with a pick.
--
-- cost_delta mirrors the app math: chosen price minus the allowance (0 when
-- there's no allowance). A price-less legacy choice is skipped so it can't
-- book a full-allowance credit.

update public.decisions d
set selected_choice_id = c.id,
    cost_delta = round(c.price_delta - coalesce(d.allowance_amount, 0), 2)
from public.decision_choices c
where c.decision_id = d.id
  and d.kind = 'selection'
  and d.status = 'approved'
  and d.selected_choice_id is null
  and d.cost_delta is null
  and c.price_delta is not null
  and (
    select count(*) from public.decision_choices c2
    where c2.decision_id = d.id
  ) = 1;

-- Buildertrend-style allowances for selections.
--
-- An allowance captures a budgeted amount (e.g. $2,000 for the front door)
-- that is already baked into the contract price. When the client picks one of
-- the pre-loaded choices, only the variance (chosen.price_delta − allowance)
-- flows into the approved-changes rollup on the pricing page. Allowances can
-- also be cost-coded so they roll up to a category (e.g. "120-200 Windows &
-- Doors") for budget reporting.
--
-- Per-choice cost breakdowns:
--   decision_cost_items.choice_id IS NULL  → line belongs to the parent
--                                            decision (existing change-order
--                                            behaviour).
--   decision_cost_items.choice_id IS NOT NULL → line belongs to that specific
--                                               choice. The choice's
--                                               price_delta is computed
--                                               app-side from the sum of its
--                                               lines × (1 + markup/100).

alter table public.decisions
  add column if not exists allowance_amount numeric(14,2),
  add column if not exists allowance_cost_code_id uuid
    references public.cost_codes(id) on delete set null;

-- Allowances only apply to selections; a cost code without an amount is
-- meaningless.
alter table public.decisions
  drop constraint if exists decisions_allowance_kind_chk,
  add constraint decisions_allowance_kind_chk
    check (allowance_amount is null or kind = 'selection');
alter table public.decisions
  drop constraint if exists decisions_allowance_code_requires_amount_chk,
  add constraint decisions_allowance_code_requires_amount_chk
    check (allowance_cost_code_id is null or allowance_amount is not null);

comment on column public.decisions.allowance_amount is
  'Buildertrend-style allowance budget (selections only). When non-null, '
  'decision_choices.price_delta is the absolute cost of each option and '
  'cost_delta on approval is set to (selected.price_delta − allowance_amount).';
comment on column public.decisions.allowance_cost_code_id is
  'Cost code the allowance is tracked against. Hidden from clients.';

-- Index for cost-code → decisions lookups (matches the existing
-- decision_cost_items pattern).
create index if not exists idx_decisions_allowance_cost_code
  on public.decisions(allowance_cost_code_id);

-- Per-choice cost-item link. ON DELETE CASCADE so removing a choice tears
-- down its breakdown rows automatically.
alter table public.decision_cost_items
  add column if not exists choice_id uuid
    references public.decision_choices(id) on delete cascade;
create index if not exists idx_dci_choice on public.decision_cost_items(choice_id);

comment on column public.decision_cost_items.choice_id is
  'When set, this line item belongs to a specific decision_choices row '
  '(allowance flow). When null, it is a decision-level line (change-order flow).';

-- Replace client_decide_decision so that approving an allowance selection
-- writes the variance into cost_delta. Body otherwise matches 0013.
create or replace function public.client_decide_decision(
  p_decision_id uuid,
  p_action text,
  p_choice_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_decision public.decisions%rowtype;
  v_client_id uuid := auth.uid();
  v_template record;
  v_new_si_id uuid;
  v_created_followups int := 0;
  v_approved_date date := current_date;
  v_choice_price numeric(14,2);
  v_variance numeric(14,2);
begin
  if v_client_id is null then
    raise exception 'not authenticated';
  end if;

  select * into v_decision from public.decisions where id = p_decision_id;
  if not found then
    raise exception 'decision not found';
  end if;

  if public.current_role_name() <> 'client' then
    raise exception 'only clients may use this action';
  end if;
  if not public.is_member_of_project(v_decision.project_id) then
    raise exception 'not a project member';
  end if;

  if p_action = 'approve' then
    if v_decision.kind = 'selection' then
      if p_choice_id is null then
        raise exception 'a choice is required for selections';
      end if;
      select price_delta into v_choice_price
        from public.decision_choices
        where id = p_choice_id and decision_id = p_decision_id;
      if not found then
        raise exception 'invalid choice for this decision';
      end if;

      if v_decision.allowance_amount is not null then
        -- Allowance flow: store the variance. Coalesce a missing price to 0
        -- so a choice with no entered cost is treated as "full credit".
        v_variance := coalesce(v_choice_price, 0) - v_decision.allowance_amount;
        update public.decisions
          set status = 'approved',
              approved_at = now(),
              approved_by_client_id = v_client_id,
              selected_choice_id = p_choice_id,
              cost_delta = v_variance
          where id = p_decision_id
            and status = 'pending_client';
      else
        update public.decisions
          set status = 'approved',
              approved_at = now(),
              approved_by_client_id = v_client_id,
              selected_choice_id = p_choice_id
          where id = p_decision_id
            and status = 'pending_client';
      end if;
      if not found then
        raise exception 'decision is not awaiting your decision';
      end if;
    else
      update public.decisions
        set status = 'approved',
            approved_at = now(),
            approved_by_client_id = v_client_id
        where id = p_decision_id
          and status = 'pending_client';
      if not found then
        raise exception 'decision is not awaiting your decision';
      end if;
    end if;

    for v_template in
      select * from public.decision_followup_templates
      where decision_id = p_decision_id
      order by position
    loop
      if exists (
        select 1 from public.schedule_items
        where source_decision_id = p_decision_id
          and description like '%[followup_template:' || v_template.id || ']%'
      ) then
        continue;
      end if;

      insert into public.schedule_items
        (project_id, kind, title, description, due_date,
         source_decision_id, created_by)
      values (
        v_decision.project_id, 'todo', v_template.title,
        coalesce(v_template.notes, '') ||
          E'\n[followup_template:' || v_template.id || ']',
        v_approved_date + v_template.due_offset_days,
        p_decision_id, v_decision.created_by
      )
      returning id into v_new_si_id;

      if v_template.assignee_profile_id is not null
         or v_template.assignee_company_id is not null then
        insert into public.schedule_assignments
          (schedule_item_id, profile_id, company_id)
        values (v_new_si_id,
                v_template.assignee_profile_id,
                v_template.assignee_company_id);
      end if;

      if v_template.assignee_profile_id is not null then
        insert into public.notifications
          (recipient_id, type, title, body, link_url)
        values (
          v_template.assignee_profile_id,
          'decision_followup',
          'Follow-up: ' || v_template.title,
          'Auto-created from an approved decision',
          '/projects/' || v_decision.project_id::text || '/schedule'
        );
      end if;

      v_created_followups := v_created_followups + 1;
    end loop;

    return jsonb_build_object(
      'status', 'approved',
      'created_followups', v_created_followups
    );
  elsif p_action = 'decline' then
    update public.decisions
      set status = 'rejected'
      where id = p_decision_id
        and status = 'pending_client';
    if not found then
      raise exception 'decision is not awaiting your decision';
    end if;
    return jsonb_build_object('status', 'rejected');
  else
    raise exception 'unknown action: %', p_action;
  end if;
end;
$fn$;

revoke execute on function public.client_decide_decision(uuid, text, uuid) from public, anon;
grant execute on function public.client_decide_decision(uuid, text, uuid) to authenticated;

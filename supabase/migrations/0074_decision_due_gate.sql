-- Past-due decisions can no longer be approved by the client.
--
-- If a change order / selection has a due_date in the past, the client's
-- approve action is rejected — they must ask staff to reset (extend) the due
-- date first. Declines stay allowed (saying "no" doesn't need a fresh price).
-- The gate lives HERE (the SECURITY DEFINER RPC is the only client write path
-- for decision transitions) so the UI check in the drawer can't be bypassed.
--
-- Body is 0035's client_decide_decision verbatim plus the due-date gate in the
-- approve branch. Keep in step with the staff twin materializeFollowups in
-- app/actions/decisions.ts.

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
  v_anchored boolean;
  v_astart date;
  v_aend date;
  v_basis date;
  v_due date;
  v_start date;
  v_end date;
  v_parent uuid;
  v_anchor schedule_parent_anchor;
  v_offset int;
  v_duration int;
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
    -- Past-due gate: approval requires a current (or absent) due date.
    if v_decision.due_date is not null and v_decision.due_date < current_date then
      raise exception 'this decision is past its due date — ask your builder to reset the due date, then approve';
    end if;

    if v_decision.kind = 'selection' then
      if p_choice_id is null then
        raise exception 'a choice is required for selections';
      end if;
      if not exists (
        select 1 from public.decision_choices
        where id = p_choice_id and decision_id = p_decision_id
      ) then
        raise exception 'invalid choice for this decision';
      end if;
      update public.decisions
        set status = 'approved',
            approved_at = now(),
            approved_by_client_id = v_client_id,
            selected_choice_id = p_choice_id
        where id = p_decision_id
          and status = 'pending_client';
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
      -- Junction-based idempotency. The PRIMARY KEY (decision_id, template_id)
      -- means a re-approval simply skips already-materialized templates.
      if exists (
        select 1 from public.decision_followup_materializations
        where decision_id = p_decision_id and template_id = v_template.id
      ) then
        continue;
      end if;

      v_anchored := v_template.anchor_schedule_item_id is not null
        and v_template.parent_anchor is not null
        and v_template.parent_offset_days is not null;
      v_due := null; v_start := null; v_end := null;
      v_parent := null; v_anchor := null; v_offset := null;
      v_duration := null; v_basis := null;

      if v_anchored then
        select start_date, end_date into v_astart, v_aend
          from public.schedule_items
          where id = v_template.anchor_schedule_item_id;
        v_basis := case
          when v_template.parent_anchor = 'start' then v_astart
          else v_aend
        end;
      end if;

      if v_template.kind = 'work' then
        if v_anchored then
          v_start := case
            when v_basis is not null then v_basis + v_template.parent_offset_days
            else null
          end;
        else
          v_start := v_approved_date + v_template.due_offset_days;
        end if;
        if v_start is not null then
          v_duration := coalesce(v_template.duration_days, 1);
          v_end := v_start + (v_duration - 1);
        end if;
      else
        if v_anchored then
          -- Anchor the materialized to-do under the schedule item so the
          -- existing cascade refreshes its due_date when that item moves.
          v_parent := v_template.anchor_schedule_item_id;
          v_anchor := v_template.parent_anchor;
          v_offset := v_template.parent_offset_days;
          v_due := case
            when v_basis is not null then v_basis + v_template.parent_offset_days
            else null
          end;
        else
          v_due := v_approved_date + v_template.due_offset_days;
        end if;
      end if;

      insert into public.schedule_items
        (project_id, parent_id, kind, title, description,
         start_date, end_date, due_date, duration_days,
         parent_anchor, parent_offset_days, source_decision_id, created_by)
      values (
        v_decision.project_id, v_parent, v_template.kind, v_template.title,
        v_template.notes, v_start, v_end, v_due,
        case when v_template.kind = 'work' then v_duration else null end,
        v_anchor, v_offset, p_decision_id, v_decision.created_by
      )
      returning id into v_new_si_id;

      insert into public.decision_followup_materializations
        (decision_id, template_id, schedule_item_id)
      values (p_decision_id, v_template.id, v_new_si_id);

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

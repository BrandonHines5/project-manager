-- Make `client_decide_decision` race-free. The previous version did a SELECT
-- to read status and then a separate UPDATE — two concurrent clients on the
-- same decision could both pass the pending_client gate and the second
-- update would win silently. Move the status check into the UPDATE WHERE
-- clause, and treat `not found` (zero affected rows) as the same "not
-- pending" error the explicit check would have raised.

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
  -- Note: we still read v_decision.status above (used for kind/choice
  -- validation below), but the actual transition is now gated atomically
  -- in the UPDATE … WHERE status = 'pending_client' clauses.

  if p_action = 'approve' then
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

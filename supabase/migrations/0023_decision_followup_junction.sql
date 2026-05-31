-- Decision-followup idempotency was previously detected by LIKE-scanning the
-- generated schedule_item.description for a `[followup_template:<id>]` marker.
-- That's fragile: if the PM edits the description and removes the marker,
-- re-approval double-creates the followup task.
--
-- Replace with an explicit junction table that records which template has
-- already been materialized for which decision. Backfill from the existing
-- marker so we don't regress on already-materialized followups.

create table if not exists public.decision_followup_materializations (
  decision_id uuid not null references public.decisions(id) on delete cascade,
  template_id uuid not null references public.decision_followup_templates(id) on delete cascade,
  schedule_item_id uuid references public.schedule_items(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (decision_id, template_id)
);
create index if not exists idx_dfm_schedule_item
  on public.decision_followup_materializations(schedule_item_id);

alter table public.decision_followup_materializations enable row level security;

drop policy if exists dfm_staff_all on public.decision_followup_materializations;
create policy dfm_staff_all on public.decision_followup_materializations
  for all using (public.is_staff()) with check (public.is_staff());

-- Backfill from the legacy LIKE marker. Best-effort: any schedule_item whose
-- description contains [followup_template:<uuid>] gets matched to that template.
insert into public.decision_followup_materializations (decision_id, template_id, schedule_item_id, created_at)
select
  si.source_decision_id,
  dft.id,
  si.id,
  si.created_at
from public.schedule_items si
join public.decision_followup_templates dft
  on dft.decision_id = si.source_decision_id
 and si.description like '%[followup_template:' || dft.id || ']%'
where si.source_decision_id is not null
on conflict (decision_id, template_id) do nothing;

-- Rewrite the client_decide_decision RPC to check the junction instead of LIKE.
-- Same body as 0013 except the idempotency check and the insert into the
-- junction after each followup creation.

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
      -- Junction-based idempotency. The PRIMARY KEY (decision_id, template_id)
      -- means a re-approval simply skips already-materialized templates.
      if exists (
        select 1 from public.decision_followup_materializations
        where decision_id = p_decision_id and template_id = v_template.id
      ) then
        continue;
      end if;

      insert into public.schedule_items
        (project_id, kind, title, description, due_date,
         source_decision_id, created_by)
      values (
        v_decision.project_id, 'todo', v_template.title,
        v_template.notes,
        v_approved_date + v_template.due_offset_days,
        p_decision_id, v_decision.created_by
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

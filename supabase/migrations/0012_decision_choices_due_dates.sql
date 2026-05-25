-- Selection choices, due dates, and a client-callable decide RPC.
--
-- For selections, staff pre-load 1+ choices (title, description, price, photos)
-- and the client picks one when approving. For change orders the client just
-- approves or declines as before — but the previously-staff-only decide
-- buttons are now exposed via the new RPC so the client can drive the
-- transition themselves.

-- 1. Selection choices ------------------------------------------------------
create table if not exists public.decision_choices (
  id uuid primary key default gen_random_uuid(),
  decision_id uuid not null references public.decisions(id) on delete cascade,
  position int not null default 0,
  title text not null,
  description text,
  price_delta numeric(14,2),
  created_at timestamptz not null default now()
);
create index if not exists idx_dch_decision on public.decision_choices(decision_id, position);

-- 2. selected_choice_id + due_date on decisions -----------------------------
alter table public.decisions
  add column if not exists selected_choice_id uuid references public.decision_choices(id) on delete set null,
  add column if not exists due_date date;
create index if not exists idx_decisions_due_date on public.decisions(project_id, due_date);
-- Cover the FK so deletes from decision_choices don't seq-scan decisions.
create index if not exists idx_decisions_selected_choice on public.decisions(selected_choice_id);

-- 3. choice_id on decision_attachments --------------------------------------
-- An attachment with choice_id IS NULL is decision-level (current behavior).
-- One with choice_id set belongs to a specific choice. The existing storage
-- RLS policy still works because it joins through decision_attachments →
-- decisions (decision_id is not null on either kind of attachment).
alter table public.decision_attachments
  add column if not exists choice_id uuid references public.decision_choices(id) on delete cascade;
create index if not exists idx_da_choice on public.decision_attachments(choice_id);

-- 4. RLS for decision_choices ----------------------------------------------
alter table public.decision_choices enable row level security;

drop policy if exists dch_staff_all on public.decision_choices;
create policy dch_staff_all on public.decision_choices
  for all using (public.is_staff()) with check (public.is_staff());

drop policy if exists dch_client_read on public.decision_choices;
create policy dch_client_read on public.decision_choices
  for select using (
    exists (
      select 1 from public.decisions d
      where d.id = decision_choices.decision_id
        and public.current_role_name() = 'client'
        and public.is_member_of_project(d.project_id)
        and d.status in ('pending_client', 'approved', 'rejected')
    )
  );

-- 5. Client decide RPC ------------------------------------------------------
-- SECURITY DEFINER so it can (a) update decisions even though our RLS is
-- staff-only and (b) insert into schedule_items / assignments / notifications
-- on approval. Inside, we re-verify the caller is a client member of the
-- decision's project so this can't be invoked by random authenticated users
-- to mutate arbitrary decisions.
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
  if v_decision.status <> 'pending_client' then
    raise exception 'decision is not awaiting your decision';
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
        where id = p_decision_id;
    else
      update public.decisions
        set status = 'approved',
            approved_at = now(),
            approved_by_client_id = v_client_id
        where id = p_decision_id;
    end if;

    -- Materialize follow-up to-dos. Same tag-based idempotency as the
    -- TS materializeFollowups in app/actions/decisions.ts — if staff later
    -- re-approves via the staff path, identical templates won't double up.
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
        v_approved_date + (v_template.due_offset_days || ' days')::interval,
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
      where id = p_decision_id;
    return jsonb_build_object('status', 'rejected');
  else
    raise exception 'unknown action: %', p_action;
  end if;
end;
$fn$;

revoke execute on function public.client_decide_decision(uuid, text, uuid) from public, anon;
grant execute on function public.client_decide_decision(uuid, text, uuid) to authenticated;

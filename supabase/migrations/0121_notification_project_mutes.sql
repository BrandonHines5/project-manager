-- Per-job notification muting (user-controlled).
--
-- A user can turn notifications off for specific jobs without touching their
-- master toggle (0036) or category preferences (0073). Enforcement mirrors
-- the master switch: notifications now carry the project they're about
-- (bare uuid, no FK — same pattern as project_history, so project deletes
-- never contend with this high-churn table; a null project_id means "not
-- job-specific" and is never muted), and the central BEFORE INSERT trigger
-- drops rows whose (recipient, project) pair is muted. That covers the
-- in-app bell AND the daily digest (which emails from those rows) across
-- every insert path. Direct per-event email senders additionally consult the
-- mute in application code (lib/notifications/preferences.ts:
-- filterProjectMuted), like they already do the master toggle.

alter table public.notifications
  add column if not exists project_id uuid;

create table if not exists public.notification_project_mutes (
  profile_id uuid not null references public.profiles(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (profile_id, project_id)
);

alter table public.notification_project_mutes enable row level security;

-- Owner-only: users manage their own mutes. A mute only ever suppresses the
-- owner's own notifications, so no staff override policy is needed.
drop policy if exists npm_owner_all on public.notification_project_mutes;
create policy npm_owner_all on public.notification_project_mutes
  for all to authenticated
  using (profile_id = (select auth.uid()))
  with check (profile_id = (select auth.uid()));

-- Extend the 0036 master-switch trigger with the per-project mute.
create or replace function public.skip_notification_if_muted()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (
    select 1 from public.profiles
    where id = new.recipient_id
      and notifications_enabled = false
  ) then
    -- Returning NULL from a BEFORE INSERT row trigger skips the insert.
    return null;
  end if;
  if new.project_id is not null and exists (
    select 1 from public.notification_project_mutes
    where profile_id = new.recipient_id
      and project_id = new.project_id
  ) then
    return null;
  end if;
  return new;
end;
$$;

revoke execute on function public.skip_notification_if_muted() from public, anon, authenticated;

-- client_decide_decision is the one SQL-side notifications insert (follow-up
-- assignee alerts on client approval); re-create it — 0074's body verbatim —
-- with project_id stamped on that insert so per-job mutes apply to it too.
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
          (recipient_id, type, title, body, link_url, project_id)
        values (
          v_template.assignee_profile_id,
          'decision_followup',
          'Follow-up: ' || v_template.title,
          'Auto-created from an approved decision',
          '/projects/' || v_decision.project_id::text || '/schedule',
          v_decision.project_id
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

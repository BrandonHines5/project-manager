-- Audit hardening: make `created_by` NOT NULL on the three tables where we
-- want a reliable authorship trail (schedule_items, daily_logs, decisions).
--
-- Backfill: legacy rows (created before the action explicitly set
-- created_by, or created via the AI agent / service role) get attributed
-- to their project's owner. That preserves real per-row authorship where
-- we know it, instead of collapsing every legacy row to a single seed
-- UUID which destroys cross-project authorship information and breaks
-- fresh-environment replays where no such seed profile exists.
--
-- Any row whose project itself has no created_by, or which has no project
-- at all, fails the final guard — the operator can resolve those by
-- assigning a project owner before replaying. That's the right failure
-- mode: better an explicit error than silent attribution to a stranger.
--
-- ON DELETE: was `set null`, which conflicts with NOT NULL. Switching to
-- `restrict` is correct: staff profile deletion shouldn't silently nuke
-- the authorship of every row they ever created. If a profile genuinely
-- needs to go, the operator must reassign authorship first.

do $$
begin
  update public.schedule_items si
    set created_by = p.created_by
  from public.projects p
  where si.project_id = p.id
    and si.created_by is null
    and p.created_by is not null;

  update public.daily_logs dl
    set created_by = p.created_by
  from public.projects p
  where dl.project_id = p.id
    and dl.created_by is null
    and p.created_by is not null;

  update public.decisions d
    set created_by = p.created_by
  from public.projects p
  where d.project_id = p.id
    and d.created_by is null
    and p.created_by is not null;

  if exists (
    select 1 from public.schedule_items where created_by is null
    union all
    select 1 from public.daily_logs where created_by is null
    union all
    select 1 from public.decisions where created_by is null
  ) then
    raise exception
      'created_by backfill left null rows; refusing to enforce NOT NULL. '
      'Set projects.created_by for the orphaned rows first.';
  end if;
end $$;

-- Backstop trigger: if any future writer (AI agent, service-role tool,
-- legacy code) forgets to set created_by, fall back to auth.uid(). When
-- auth.uid() is also null (e.g. true service role with no JWT), the NOT NULL
-- constraint below will reject the row — which is the correct outcome.
-- This makes the constraint deploy-order-independent: action code that
-- already sets created_by still works; older code paths get the auth user
-- automatically; rogue inserts fail loudly.

create or replace function public.fill_created_by_from_auth()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.created_by is null then
    new.created_by := auth.uid();
  end if;
  return new;
end;
$$;

drop trigger if exists trg_si_fill_created_by on public.schedule_items;
create trigger trg_si_fill_created_by
  before insert on public.schedule_items
  for each row execute function public.fill_created_by_from_auth();

drop trigger if exists trg_dl_fill_created_by on public.daily_logs;
create trigger trg_dl_fill_created_by
  before insert on public.daily_logs
  for each row execute function public.fill_created_by_from_auth();

drop trigger if exists trg_dec_fill_created_by on public.decisions;
create trigger trg_dec_fill_created_by
  before insert on public.decisions
  for each row execute function public.fill_created_by_from_auth();

-- Lock down RPC exposure. This function is only ever invoked as a trigger;
-- exposing it via PostgREST would let any authenticated user write a row via
-- its side effects (auth.uid()).
revoke execute on function public.fill_created_by_from_auth() from public, anon, authenticated;

-- Swap FK behavior: set null -> restrict, then set NOT NULL.
-- Constraint names are the postgres defaults from 0001/0003/0004.

alter table public.schedule_items
  drop constraint if exists schedule_items_created_by_fkey,
  add constraint schedule_items_created_by_fkey
    foreign key (created_by) references public.profiles(id) on delete restrict;
alter table public.schedule_items
  alter column created_by set not null;

alter table public.daily_logs
  drop constraint if exists daily_logs_created_by_fkey,
  add constraint daily_logs_created_by_fkey
    foreign key (created_by) references public.profiles(id) on delete restrict;
alter table public.daily_logs
  alter column created_by set not null;

alter table public.decisions
  drop constraint if exists decisions_created_by_fkey,
  add constraint decisions_created_by_fkey
    foreign key (created_by) references public.profiles(id) on delete restrict;
alter table public.decisions
  alter column created_by set not null;

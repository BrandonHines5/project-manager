-- Security & correctness hardening. Addresses code-review findings #1-3, #8, #11, #12.

-- 1. profiles.email: allow NULL so phone/OAuth signups don't crash the trigger.
alter table public.profiles alter column email drop not null;

-- 2. handle_new_user: never trust client-supplied role. Public signup defaults
-- to 'client' (least privilege). Staff promote users via /team.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, full_name, role)
  values (
    new.id,
    new.email,
    coalesce(
      new.raw_user_meta_data->>'full_name',
      split_part(coalesce(new.email, ''), '@', 1)
    ),
    'client'::public.user_role
  );
  return new;
end $$;

-- 3. Prevent privilege escalation via direct UPDATE on profiles.role.
-- The existing profiles_self_update RLS lets a user update any column on their
-- own row, including role — full self-promotion to staff. Gate role changes
-- with a BEFORE UPDATE trigger that requires is_staff().
create or replace function public.prevent_role_escalation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.role is distinct from new.role and not public.is_staff() then
    raise exception 'Only staff can change a user role'
      using errcode = '42501';
  end if;
  return new;
end $$;
grant execute on function public.prevent_role_escalation() to anon, authenticated;

drop trigger if exists trg_prevent_role_escalation on public.profiles;
create trigger trg_prevent_role_escalation
  before update on public.profiles
  for each row execute function public.prevent_role_escalation();

-- 4. Drop the over-permissive notifications_self_all policy. 0007 already
-- added narrower self_read / self_update / staff_insert. Without this drop,
-- any authenticated user could insert forged notifications addressed to
-- themselves (spam / phishing link bait via the bell).
drop policy if exists notifications_self_all on public.notifications;

-- 5. Race-safe decision numbering: advisory lock per project, then compute.
-- Combined with retry-on-23505 in app/actions/decisions.ts.
create or replace function public.next_decision_number(p_project uuid)
returns int
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  next_num int;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_project::text, 0));
  select coalesce(max(number), 0) + 1
    into next_num
    from public.decisions
    where project_id = p_project;
  return next_num;
end $fn$;
grant execute on function public.next_decision_number(uuid) to authenticated;

-- 6. Allow a user to self-heal their own profile row if the trigger ever
-- failed at signup (auth user with no profile = login dead-lock). Role is
-- locked to 'client' on insert; later staff promotion is gated by
-- prevent_role_escalation.
drop policy if exists profiles_self_insert on public.profiles;
create policy profiles_self_insert on public.profiles
  for insert with check (id = auth.uid() and role = 'client'::public.user_role);

-- 7. Performance: index storage_path used in the storage RLS predicate. Without
-- these, every signed-URL read does three sequential scans across
-- daily_log_attachments / decision_attachments / project_files.
create index if not exists idx_dla_storage_path
  on public.daily_log_attachments(storage_bucket, storage_path);
create index if not exists idx_da_storage_path
  on public.decision_attachments (storage_bucket, storage_path);
create index if not exists idx_pf_storage_path
  on public.project_files        (storage_bucket, storage_path);

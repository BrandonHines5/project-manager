-- Trash purge hardening (review follow-ups to 0088).
--
-- Three problems with the original purge_expired_deleted_items:
--   1. It DELETED the trash rows and only then did the caller remove the
--      Storage objects — a failed removal orphaned the objects forever (the
--      only record of their paths was gone).
--   2. Overlapping snapshots from a bulk delete (a child to-do rides inside
--      its parent's subtree AND gets its own entry) could expire while the
--      entity was live again via a different entry's restore, purging Storage
--      objects the restored rows still reference.
--   3. Retention ran only when staff opened a project's History page —
--      projects nobody revisits kept snapshots (and bid tokens) forever.
--
-- New shape: list → clean Storage → finalize. Rows are retained until their
-- objects are actually gone (a failed removal just retries on the next
-- sweep), every candidate path is re-checked against the live attachment
-- tables at purge time, and a daily cron (/api/cron/trash-purge, service
-- role) sweeps every project so retention no longer depends on page traffic.

drop function if exists public.purge_expired_deleted_items(uuid);

-- Shared gate: staff sessions (History-page lazy sweep) or the service role
-- (the cron, which has no user session).
create or replace function public.trash_purge_allowed()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  -- Coalesced: auth.role() is null on direct DB connections, and
  -- `false OR null` is null — which `if not ...` guards would let through.
  select coalesce(public.is_staff() or auth.role() = 'service_role', false);
$$;
revoke execute on function public.trash_purge_allowed() from public, anon;
grant execute on function public.trash_purge_allowed() to authenticated, service_role;

-- Step 1: what's past retention? Read-only — nothing is deleted yet.
create or replace function public.list_expired_deleted_items(p_project uuid)
returns table (id uuid, storage_paths text[], was_restored boolean)
language plpgsql
stable
security definer
set search_path = public
as $fn$
begin
  if not public.trash_purge_allowed() then
    raise exception 'staff only';
  end if;
  return query
    select d.id, d.storage_paths, (d.restored_at is not null)
      from public.deleted_items d
     where d.project_id = p_project
       and d.deleted_at < now() - interval '30 days';
end;
$fn$;

-- Step 2 helper: which of these Storage paths are safe to remove? A path is
-- kept whenever ANY live row still references it — covers entities brought
-- back through a different overlapping trash entry, re-uploads to the same
-- key, and anything else that re-adopted the object since the snapshot.
create or replace function public.unreferenced_storage_paths(p_paths text[])
returns text[]
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_out text[];
begin
  if not public.trash_purge_allowed() then
    raise exception 'staff only';
  end if;
  select coalesce(array_agg(p), '{}') into v_out
    from unnest(p_paths) as p
   where not exists (select 1 from public.daily_log_attachments a where a.storage_path = p)
     and not exists (select 1 from public.decision_attachments a where a.storage_path = p)
     and not exists (select 1 from public.schedule_item_attachments a where a.storage_path = p)
     and not exists (select 1 from public.bid_package_attachments a where a.storage_path = p)
     and not exists (select 1 from public.po_attachments a where a.storage_path = p)
     and not exists (select 1 from public.project_files f where f.storage_path = p);
  return v_out;
end;
$fn$;

-- Step 3: only after the caller's Storage removals all succeeded. Re-asserts
-- expiry so a stale caller can't delete rows that aren't actually due.
create or replace function public.finalize_purged_deleted_items(
  p_project uuid, p_ids uuid[]
)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if not public.trash_purge_allowed() then
    raise exception 'staff only';
  end if;
  delete from public.deleted_items d
   where d.project_id = p_project
     and d.id = any(p_ids)
     and d.deleted_at < now() - interval '30 days';
end;
$fn$;

revoke execute on function public.list_expired_deleted_items(uuid) from public, anon;
revoke execute on function public.unreferenced_storage_paths(text[]) from public, anon;
revoke execute on function public.finalize_purged_deleted_items(uuid, uuid[]) from public, anon;
grant execute on function public.list_expired_deleted_items(uuid) to authenticated, service_role;
grant execute on function public.unreferenced_storage_paths(text[]) to authenticated, service_role;
grant execute on function public.finalize_purged_deleted_items(uuid, uuid[]) to authenticated, service_role;

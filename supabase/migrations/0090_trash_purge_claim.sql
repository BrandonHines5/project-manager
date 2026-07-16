-- Serialize trash purging against restores + make the sweep paginated
-- (review follow-ups to 0089).
--
-- Two holes in the 0089 flow:
--   1. Race: unreferenced_storage_paths was a point-in-time check. A restore
--      claiming an entry between that check and the Storage .remove() could
--      re-attach a path just before its object was deleted.
--   2. Truncation: PostgREST caps responses at 1,000 rows, so a huge backlog
--      could make list_expired_deleted_items (and the cron's project scan)
--      silently stop early. Self-draining across sweeps, but not exhaustive
--      in one run.
--
-- Fix: purging now CLAIMS rows first (purge_claimed_at), in explicit batches.
-- claim_deleted_item (restore) refuses purge-claimed entries, and the claim
-- batch is taken before the reference check, so once a batch is claimed no
-- restore can re-attach its paths. A claim goes stale after 1 hour (crash
-- between claim and finalize) and is re-swept; a failed Storage removal
-- unclaims immediately so the next sweep retries without the wait.

alter table public.deleted_items
  add column if not exists purge_claimed_at timestamptz;

-- Restore must not touch an entry the purge has claimed (it's expired and
-- mid-deletion). Same body as 0088 plus the purge_claimed_at condition.
create or replace function public.claim_deleted_item(p_id uuid)
returns setof public.deleted_items
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if not public.is_staff() then
    raise exception 'staff only';
  end if;
  return query
    update public.deleted_items
       set restored_at = now(), restored_by = auth.uid()
     where id = p_id
       and restored_at is null
       and purge_claimed_at is null
    returning *;
end;
$fn$;

-- Purge step 1: claim one batch of expired entries. The row limit keeps the
-- RETURNING set safely under PostgREST's response cap — callers loop until a
-- claim returns nothing. Stale claims (crashed sweeps) are re-claimable
-- after an hour.
drop function if exists public.list_expired_deleted_items(uuid);

create or replace function public.claim_expired_deleted_items(
  p_project uuid, p_limit int default 200
)
returns table (id uuid, storage_paths text[], was_restored boolean)
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if not public.trash_purge_allowed() then
    raise exception 'staff only';
  end if;
  return query
    update public.deleted_items d
       set purge_claimed_at = now()
     where d.id in (
       select di.id from public.deleted_items di
        where di.project_id = p_project
          and di.deleted_at < now() - interval '30 days'
          and (di.purge_claimed_at is null
            or di.purge_claimed_at < now() - interval '1 hour')
        order by di.deleted_at
        limit greatest(1, least(p_limit, 200))
     )
    returning d.id, d.storage_paths, (d.restored_at is not null);
end;
$fn$;

-- Release a claimed batch after a failed Storage removal so the next sweep
-- retries immediately instead of waiting out the stale-claim hour.
create or replace function public.unclaim_purged_deleted_items(
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
  update public.deleted_items d
     set purge_claimed_at = null
   where d.project_id = p_project
     and d.id = any(p_ids);
end;
$fn$;

revoke execute on function public.claim_expired_deleted_items(uuid, int) from public, anon;
revoke execute on function public.unclaim_purged_deleted_items(uuid, uuid[]) from public, anon;
grant execute on function public.claim_expired_deleted_items(uuid, int) to authenticated, service_role;
grant execute on function public.unclaim_purged_deleted_items(uuid, uuid[]) to authenticated, service_role;

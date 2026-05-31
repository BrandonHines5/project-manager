-- Plan / contract / permit revision history. The current setup lets staff
-- upload a "house_plans rev C" as a sibling of "house_plans rev B" with no
-- linkage between them — clients reading the gallery have no way to tell
-- which version is current, and a PM has to rely on file naming
-- conventions to spot duplicates.
--
-- Promote that to a real chain via a self-reference. `parent_file_id` always
-- points at the v1 row (chain is intentionally flat: B replaces A → A is
-- parent, B is v2; C replaces B → A is still parent, C is v3). Storage
-- objects are not deleted when a newer version is uploaded; older versions
-- stay accessible so a client who downloaded "rev B" yesterday isn't
-- looking at a 404 today.

alter table public.project_files
  add column if not exists parent_file_id uuid references public.project_files(id) on delete set null,
  add column if not exists version int not null default 1
    check (version >= 1);

create index if not exists idx_pf_parent
  on public.project_files(parent_file_id)
  where parent_file_id is not null;

-- "current" view: every file whose row IS the head of its chain. A head
-- is either a v1 with no children or any row that no other row points to
-- as parent. We keep a generated boolean column (Postgres 17 makes this
-- cheap) so the gallery query stays a simple WHERE filter instead of a
-- correlated NOT EXISTS.
--
-- Actually computed at write time via trigger — generated columns can't
-- reference other rows in Postgres. Default true; revision insert sets
-- the prior head to false in the action layer.

alter table public.project_files
  add column if not exists is_current boolean not null default true;
create index if not exists idx_pf_current
  on public.project_files(project_id, category)
  where is_current = true;

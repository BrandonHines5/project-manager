-- Checklist items can be assigned to a role, mirroring the third leg of
-- schedule_assignments' profile-XOR-company-XOR-role shape. Role assignees
-- resolve through project_role_members like any other role assignment, so a
-- template's checklist items can say "Plumber" and follow the role map on
-- each job created from it.
--
-- Nullable + on delete set null for the same reason as 0038: deleting a role
-- must not cascade-delete checklist rows — the item just loses its assignee.
-- The at-most-one-assignee rule stays app-enforced in saveScheduleItem
-- (matching 0038, which added no check constraint for profile/company).

alter table public.todo_checklist_items
  add column if not exists assignee_role_id uuid
    references public.roles(id) on delete set null;

create index if not exists idx_tci_assignee_role
  on public.todo_checklist_items(assignee_role_id);

-- RLS: todo_checklist_items_staff_all already covers the new column; writes
-- still flow through staff sessions and the server action.

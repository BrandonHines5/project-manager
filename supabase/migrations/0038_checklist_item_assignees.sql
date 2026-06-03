-- Per-checklist-item assignees.
--
-- A to-do's checklist items can now each carry an assignee — either an
-- internal profile or a sub/vendor company (mirrors schedule_assignments'
-- profile-XOR-company shape). When a checklist item is assigned to someone,
-- the app also adds that person/company to the parent to-do's assignments so
-- the to-do surfaces in their queue; that roll-up is handled in the
-- saveScheduleItem server action, not here.
--
-- Both columns are nullable: a checklist item with no assignee is the common
-- case. on delete set null so removing a profile/company doesn't cascade-
-- delete checklist rows — the item just loses its assignee.

alter table public.todo_checklist_items
  add column if not exists assignee_profile_id uuid
    references public.profiles(id) on delete set null,
  add column if not exists assignee_company_id uuid
    references public.companies(id) on delete set null;

create index if not exists idx_tci_assignee_profile
  on public.todo_checklist_items(assignee_profile_id);
create index if not exists idx_tci_assignee_company
  on public.todo_checklist_items(assignee_company_id);

-- RLS: todo_checklist_items already has a staff-all policy
-- (todo_checklist_items_staff_all, for all using is_staff()). The new columns
-- need no additional policy — writes still flow through staff sessions and
-- the server action.

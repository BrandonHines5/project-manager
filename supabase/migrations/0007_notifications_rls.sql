drop policy if exists notifications_self_read on public.notifications;
create policy notifications_self_read on public.notifications
  for select using (recipient_id = auth.uid());

drop policy if exists notifications_self_update on public.notifications;
create policy notifications_self_update on public.notifications
  for update using (recipient_id = auth.uid())
  with check (recipient_id = auth.uid());

drop policy if exists notifications_staff_insert on public.notifications;
create policy notifications_staff_insert on public.notifications
  for insert with check (public.is_staff());

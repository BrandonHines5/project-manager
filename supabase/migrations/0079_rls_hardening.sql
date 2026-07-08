-- RLS hardening from PR #127 review.
--
-- 1. decision_assignments: trades could read assignment rows pointing at
--    DRAFT decisions (the decision itself is hidden, but the row leaks its
--    existence). Gate self-reads on the same non-draft status list as
--    decisions_trade_read.
-- 2. Attachments for role-assigned schedule items: both the storage policy
--    and the sia_trade_read table policy only matched DIRECT assignments
--    (profile/company), so a trade visible via a role could see the item and
--    its comments but not its attachments. Extend both with the 0054 role
--    path.
-- 3. app_settings: read-all-authenticated exposed every current AND future
--    key to clients/trades. Scope non-staff reads to the one public key.

drop policy if exists dass_self_read on public.decision_assignments;
create policy dass_self_read on public.decision_assignments
  for select using (
    exists (
      select 1 from public.decisions d
      where d.id = decision_assignments.decision_id
        and d.status in ('pending_client', 'approved', 'rejected')
    )
    and (
      profile_id = (select auth.uid())
      or exists (
        select 1 from public.profiles p
        where p.id = (select auth.uid())
          and p.company_id = decision_assignments.company_id
      )
      or (
        role_id is not null
        and exists (
          select 1
          from public.decisions d
          join public.project_role_members prm
            on prm.role_id = decision_assignments.role_id
           and prm.project_id = d.project_id
          join public.profiles p on p.id = (select auth.uid())
          where d.id = decision_assignments.decision_id
            and (prm.profile_id = p.id or prm.company_id = p.company_id)
        )
      )
    )
  );

drop policy if exists project_files_trade_read on storage.objects;
create policy project_files_trade_read on storage.objects
  for select using (
    bucket_id = 'project-files'
    and public.current_role_name() = 'trade'
    and (
      exists (
        select 1
        from public.schedule_item_attachments sia
        join public.schedule_assignments sa on sa.schedule_item_id = sia.schedule_item_id
        left join public.profiles p on p.id = auth.uid()
        where sia.storage_path = storage.objects.name
          and sia.storage_bucket = storage.objects.bucket_id
          and (
            sa.profile_id = auth.uid()
            or sa.company_id = p.company_id
            or (
              sa.role_id is not null
              and public.trade_sees_assignment_via_role(
                sa.role_id,
                sia.schedule_item_id
              )
            )
          )
      )
      or exists (
        select 1
        from public.decision_attachments da
        join public.decisions d on d.id = da.decision_id
        where da.storage_path = storage.objects.name
          and da.storage_bucket = storage.objects.bucket_id
          and d.status in ('pending_client', 'approved', 'rejected')
          and public.trade_sees_decision(d.id)
      )
    )
  );

-- Same role-path gap on the attachment ROWS themselves (0015's sia_trade_read
-- predates roles and was never extended in 0054).
drop policy if exists sia_trade_read on public.schedule_item_attachments;
create policy sia_trade_read on public.schedule_item_attachments
  for select using (
    public.current_role_name() = 'trade'
    and (
      exists (
        select 1 from public.schedule_assignments sa
        left join public.profiles p on p.id = auth.uid()
        where sa.schedule_item_id = schedule_item_attachments.schedule_item_id
          and (sa.profile_id = auth.uid() or sa.company_id = p.company_id)
      )
      or public.trade_sees_item_via_role(schedule_item_attachments.schedule_item_id)
    )
  );

drop policy if exists app_settings_read_all on public.app_settings;
create policy app_settings_read_all on public.app_settings
  for select to authenticated using (
    key = 'decision_disclaimer'
    or public.is_staff()
  );

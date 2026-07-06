-- Comments on schedule items (staff ↔ assigned trades) and daily logs
-- (staff ↔ client, client-visible logs only). author_name snapshots the
-- display name (bid_comments/po_comments convention) so trades/clients never
-- need to read other users' profiles rows, which profiles RLS forbids.

create table if not exists public.schedule_item_comments (
  id uuid primary key default gen_random_uuid(),
  schedule_item_id uuid not null references public.schedule_items(id) on delete cascade,
  author_id uuid references public.profiles(id) on delete set null,
  author_name text not null,
  body text not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_sic_item on public.schedule_item_comments(schedule_item_id, created_at);
create index if not exists idx_sic_author on public.schedule_item_comments(author_id);

create table if not exists public.daily_log_comments (
  id uuid primary key default gen_random_uuid(),
  daily_log_id uuid not null references public.daily_logs(id) on delete cascade,
  author_id uuid references public.profiles(id) on delete set null,
  author_name text not null,
  body text not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_dlc_log on public.daily_log_comments(daily_log_id, created_at);
create index if not exists idx_dlc_author on public.daily_log_comments(author_id);

alter table public.schedule_item_comments enable row level security;
alter table public.daily_log_comments    enable row level security;

drop policy if exists sic_staff_all on public.schedule_item_comments;
create policy sic_staff_all on public.schedule_item_comments
  for all using (public.is_staff()) with check (public.is_staff());

-- Trade gate mirrors schedule_items_trade_read (0054): direct assignment
-- (profile or company) or the role-based path.
drop policy if exists sic_trade_read on public.schedule_item_comments;
create policy sic_trade_read on public.schedule_item_comments
  for select using (
    public.current_role_name() = 'trade'
    and (
      exists (
        select 1 from public.schedule_assignments sa
        left join public.profiles p on p.id = auth.uid()
        where sa.schedule_item_id = schedule_item_comments.schedule_item_id
          and (sa.profile_id = auth.uid() or sa.company_id = p.company_id)
      )
      or public.trade_sees_item_via_role(schedule_item_comments.schedule_item_id)
    )
  );

drop policy if exists sic_trade_insert on public.schedule_item_comments;
create policy sic_trade_insert on public.schedule_item_comments
  for insert with check (
    author_id = auth.uid()
    and public.current_role_name() = 'trade'
    and (
      exists (
        select 1 from public.schedule_assignments sa
        left join public.profiles p on p.id = auth.uid()
        where sa.schedule_item_id = schedule_item_comments.schedule_item_id
          and (sa.profile_id = auth.uid() or sa.company_id = p.company_id)
      )
      or public.trade_sees_item_via_role(schedule_item_comments.schedule_item_id)
    )
  );

drop policy if exists dlc_staff_all on public.daily_log_comments;
create policy dlc_staff_all on public.daily_log_comments
  for all using (public.is_staff()) with check (public.is_staff());

-- Client gate mirrors daily_logs_client_read (0003): client-visible logs on
-- projects the client is a member of. Trades have no daily-log access.
drop policy if exists dlc_client_read on public.daily_log_comments;
create policy dlc_client_read on public.daily_log_comments
  for select using (
    exists (
      select 1 from public.daily_logs dl
      where dl.id = daily_log_comments.daily_log_id
        and public.current_role_name() = 'client'
        and dl.visibility = 'client'
        and public.is_member_of_project(dl.project_id)
    )
  );

drop policy if exists dlc_client_insert on public.daily_log_comments;
create policy dlc_client_insert on public.daily_log_comments
  for insert with check (
    author_id = auth.uid()
    and exists (
      select 1 from public.daily_logs dl
      where dl.id = daily_log_comments.daily_log_id
        and public.current_role_name() = 'client'
        and dl.visibility = 'client'
        and public.is_member_of_project(dl.project_id)
    )
  );

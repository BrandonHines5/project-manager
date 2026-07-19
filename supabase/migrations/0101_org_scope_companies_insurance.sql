-- 0101: Stage B2 module 2 — org-scope companies + insurance RLS.
--
-- Entirely DB-side (no app-code companion): the only insert path into
-- companies/company_trades is the save_company_with_trades definer RPC,
-- rewritten here to stamp org_id from the caller's membership. Policies on
-- companies, company_trades, insurance_documents, insurance_policies gain the
-- org condition. companies drops its bridge default; insurance_documents
-- KEEPS its default until Stage B4 — its inserts come from the admin-client
-- ingest pipeline whose inbound channels (email webhook, upload tokens) only
-- become org-aware when integrations do. companies_self_read is untouched
-- (a profile reading its own company is inherently row-safe).

create or replace function public.save_company_with_trades(
  p_id uuid, p_name text, p_type company_type, p_address text,
  p_phone text, p_email text, p_notes text, p_trades text[]
)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_id uuid := p_id;
  v_first_trade text := null;
  v_org uuid;
begin
  if not public.is_staff() then
    raise exception 'only staff may save companies';
  end if;

  select org_id into v_org
  from public.organization_members
  where profile_id = auth.uid()
  order by created_at
  limit 1;
  if v_org is null then
    raise exception 'caller is not a member of any organization';
  end if;

  if array_length(p_trades, 1) is null then
    p_trades := array[]::text[];
  end if;
  if array_length(p_trades, 1) > 20 then
    raise exception 'at most 20 trades per company';
  end if;
  if array_length(p_trades, 1) is not null then
    v_first_trade := p_trades[1];
  end if;

  if v_id is null then
    insert into public.companies (org_id, name, type, address, phone, email, notes, trade_category)
    values (v_org, p_name, p_type, p_address, p_phone, p_email, p_notes, v_first_trade)
    returning id into v_id;
  else
    -- The org predicate keeps a caller from editing another org's company by id.
    update public.companies
      set name = p_name,
          type = p_type,
          address = p_address,
          phone = p_phone,
          email = p_email,
          notes = p_notes,
          trade_category = v_first_trade
      where id = v_id and org_id = v_org;
    if not found then
      raise exception 'company not found';
    end if;
  end if;

  delete from public.company_trades where company_id = v_id;
  if array_length(p_trades, 1) is not null then
    insert into public.company_trades (company_id, trade)
    select v_id, unnest(p_trades);
  end if;

  return v_id;
end;
$function$;

-- companies --------------------------------------------------------------

drop policy companies_staff_all on companies;
create policy companies_staff_all on companies
  as permissive for all
  using (is_staff() and is_org_member(org_id))
  with check (is_staff() and is_org_member(org_id));

-- company_trades (child; scopes via parent company) ----------------------

drop policy company_trades_read_all on company_trades;
create policy company_trades_read_all on company_trades
  for select
  using (
    is_staff()
    and exists (
      select 1 from companies c
      where c.id = company_trades.company_id and is_org_member(c.org_id)
    )
  );

drop policy company_trades_staff_all on company_trades;
create policy company_trades_staff_all on company_trades
  as permissive for all
  using (
    is_staff()
    and exists (
      select 1 from companies c
      where c.id = company_trades.company_id and is_org_member(c.org_id)
    )
  )
  with check (
    is_staff()
    and exists (
      select 1 from companies c
      where c.id = company_trades.company_id and is_org_member(c.org_id)
    )
  );

-- insurance_documents (root; bridge default stays until B4) --------------

drop policy insdoc_staff_all on insurance_documents;
create policy insdoc_staff_all on insurance_documents
  as permissive for all
  using (is_staff() and is_org_member(org_id))
  with check (is_staff() and is_org_member(org_id));

-- insurance_policies (child; scopes via parent company) ------------------

drop policy inspol_staff_all on insurance_policies;
create policy inspol_staff_all on insurance_policies
  as permissive for all
  using (
    is_staff()
    and exists (
      select 1 from companies c
      where c.id = insurance_policies.company_id and is_org_member(c.org_id)
    )
  )
  with check (
    is_staff()
    and exists (
      select 1 from companies c
      where c.id = insurance_policies.company_id and is_org_member(c.org_id)
    )
  );

-- Bridge default off for companies (the RPC now stamps org explicitly).

alter table companies alter column org_id drop default;

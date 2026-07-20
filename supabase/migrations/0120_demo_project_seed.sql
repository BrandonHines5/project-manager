-- 0120: Stage S follow-up — seed a demo project into new trial sandboxes.
--
-- A trial signup used to land the owner in a completely EMPTY workspace (no
-- projects, nothing to click). seed_demo_project() stands up one realistic
-- sample job — schedule with milestones/predecessors/assignments, a pending
-- client selection + a draft change order, daily logs, a few demo sub
-- companies, and role assignments — so the first thing a trial user sees is
-- the product working, not a blank slate.
--
-- Design decisions:
--  * PURPOSE-BUILT content defined right here — never copied from Hines' (or
--    any tenant's) real project rows. The only cross-org reads are the org's
--    OWN roles/cost_codes (which create_organization already seeded as
--    catalog copies); lookups are name-based and null-safe, so a differently
--    seeded org just gets uncoded line items / fewer role chips.
--  * Only seeds an org with ZERO projects AND ZERO companies (early return
--    otherwise) — it can never pollute a workspace that has real work or a
--    real vendor directory, and re-running is a no-op.
--  * Demo companies carry NO email/phone and notifications_enabled=false, so
--    no send path (bid invite, PO release, SMS) can ever reach a real inbox
--    from demo data. Their status is 'Demo data', which the insurance module
--    does not treat as requiring coverage ('Approved for Use' is the trigger).
--  * Every child row stamps created_by = p_owner explicitly: under a
--    SECURITY DEFINER call auth.uid() is NULL, so the 0021 fill-triggers
--    can't help and the NOT NULLs would reject the rows otherwise.
--  * project_number is GLOBALLY unique (0001 — never re-scoped per-org), so
--    the demo number derives from the org uuid: 'DEMO-' || first 8 hex chars.
--  * Dates are relative to current_date: ~3 weeks of completed work behind,
--    framing in progress today, substantial completion ~3 months out — the
--    schedule looks alive on day one. Successor start dates sit exactly at
--    predecessor end + 1, matching cascadeFromPredecessors' FS math, so the
--    first user-driven date move doesn't renormalize the seeded history.
--  * The project is seeded BASELINED (work-item dates copied into the
--    baseline columns, projects.baseline_set_at stamped): the app's invariant
--    is that work items can only be 'complete' post-baseline, so a demo with
--    finished work must carry a locked plan — and the health banner then
--    opens on the green "days remaining in buffer" state instead of a
--    "lock the plan" prompt contradicted by already-complete rows.
--  * No notifications are inserted, no Storage objects.
--  * The 0119 sandbox teardown already covers demo rows: projects cascade
--    their children and companies are org-scoped flat roots.
--
-- create_sandbox_organization() now calls this AFTER stamping the trial
-- lifecycle, wrapped so a seed failure can NEVER fail a signup — worst case
-- the trial starts empty (today's behavior) and the warning lands in the DB
-- logs. Operator-provisioned orgs (create_organization via /settings/
-- provision-org) intentionally do NOT get a demo project.
--
-- Both functions remain SERVICE-ROLE-ONLY.

-- 1. The seed --------------------------------------------------------------

create or replace function public.seed_demo_project(
  p_org uuid,
  p_owner uuid
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  d date := current_date;
  v_project uuid := gen_random_uuid();
  -- Deterministic per-org demo number; project_number is GLOBALLY unique, so
  -- the loop below re-rolls on the (astronomically rare) prefix collision
  -- instead of failing the seed.
  v_number text := 'DEMO-' || substr(p_org::text, 1, 8);

  -- Demo sub companies
  c_fram  uuid := gen_random_uuid();
  c_plumb uuid := gen_random_uuid();
  c_elec  uuid := gen_random_uuid();

  -- Work items (schedule)
  ms_start uuid := gen_random_uuid();
  w_site   uuid := gen_random_uuid();
  w_found  uuid := gen_random_uuid();
  w_frame  uuid := gen_random_uuid();
  w_roof   uuid := gen_random_uuid();
  w_wind   uuid := gen_random_uuid();
  w_plumb  uuid := gen_random_uuid();
  w_hvac   uuid := gen_random_uuid();
  w_elec   uuid := gen_random_uuid();
  w_insul  uuid := gen_random_uuid();
  w_dry    uuid := gen_random_uuid();
  w_trim   uuid := gen_random_uuid();
  w_cab    uuid := gen_random_uuid();
  w_paint  uuid := gen_random_uuid();
  w_floor  uuid := gen_random_uuid();
  w_mep    uuid := gen_random_uuid();
  w_punch  uuid := gen_random_uuid();
  ms_sub   uuid := gen_random_uuid();

  -- To-dos
  t_windows uuid := gen_random_uuid();
  t_inspect uuid := gen_random_uuid();
  t_walk    uuid := gen_random_uuid();

  -- Decisions
  d_counter uuid := gen_random_uuid();
  d_patio   uuid := gen_random_uuid();
  ch_quartz uuid := gen_random_uuid();
  ch_gran   uuid := gen_random_uuid();
  ch_butch  uuid := gen_random_uuid();

  -- Daily logs
  dl_client   uuid := gen_random_uuid();
  dl_internal uuid := gen_random_uuid();

  -- Null-safe catalog lookups (roles/cost codes were copied into the org by
  -- create_organization; a miss just means fewer chips / uncoded line items)
  r_pm    uuid;
  r_fram  uuid;
  r_plumb uuid;
  r_elec  uuid;
  r_hvac  uuid;
  cc_counter uuid;
  cc_slab    uuid;
  cc_framing uuid;
begin
  -- Never touch a workspace that already has real work — projects OR a
  -- companies directory; also makes the call idempotent (signup path + any
  -- manual backfill, including after the user deletes the demo project but
  -- keeps its companies).
  if exists (select 1 from projects where org_id = p_org)
     or exists (select 1 from companies where org_id = p_org) then
    return null;
  end if;

  -- Defense in depth for manual/backfill calls: the owner every child row is
  -- attributed to must actually belong to the target org, or role/assignment
  -- rows would grant a FOREIGN profile read access into this tenant.
  if not exists (
    select 1 from organization_members
     where org_id = p_org and profile_id = p_owner
  ) then
    raise exception 'seed_demo_project: % is not a member of org %', p_owner, p_org;
  end if;

  while exists (select 1 from projects where project_number = v_number) loop
    v_number := 'DEMO-' || substr(gen_random_uuid()::text, 1, 8);
  end loop;

  select id into r_pm    from roles where org_id = p_org and lower(trim(name)) = 'project manager' limit 1;
  select id into r_fram  from roles where org_id = p_org and lower(trim(name)) = 'framer' limit 1;
  select id into r_plumb from roles where org_id = p_org and lower(trim(name)) = 'plumber' limit 1;
  select id into r_elec  from roles where org_id = p_org and lower(trim(name)) = 'electrician' limit 1;
  select id into r_hvac  from roles where org_id = p_org and name ilike 'hvac%' order by position limit 1;

  select id into cc_counter from cost_codes where org_id = p_org and name ilike '%countertop%'        order by code limit 1;
  select id into cc_slab    from cost_codes where org_id = p_org and name ilike '%slab%concrete%'     order by code limit 1;
  select id into cc_framing from cost_codes where org_id = p_org and name ilike 'framing%labor%'      order by code limit 1;

  -- Project ------------------------------------------------------------------
  -- Baselined at creation (see header): baseline_set_at backdated to the job
  -- start so the timeline reads naturally.
  insert into projects (id, org_id, project_number, name, address, status,
                        project_type, start_date, contract_price,
                        client_name, created_by, notes,
                        baseline_set_at, baseline_set_by)
  values (v_project, p_org, v_number,
          'Demo — 1420 Maple Street', '1420 Maple Street', 'in_work',
          'residential_new', d - 21, 485000,
          'Alex & Jordan Rivera', p_owner,
          'Sample project created with your trial workspace so you can explore '
          || 'the schedule, decisions, and daily logs with real-looking data. '
          || 'Feel free to change anything or delete the whole project — your '
          || 'real jobs are unaffected.',
          now() - interval '21 days', p_owner);

  -- Demo sub companies ---------------------------------------------------------
  -- No email/phone on purpose: nothing can be sent to them. notifications off
  -- as belt-and-suspenders. Status is NOT 'Approved for Use', so the insurance
  -- dashboard doesn't demand coverage for pretend vendors.
  insert into companies (id, org_id, name, type, trade_category, contact_name,
                         status, notifications_enabled)
  values
    (c_fram,  p_org, 'Summit Framing Co.',   'sub', 'Framing',    'Ray Alvarez',   'Demo data', false),
    (c_plumb, p_org, 'Ace Plumbing Co.',     'sub', 'Plumbing',   'Dana Whitfield','Demo data', false),
    (c_elec,  p_org, 'Bright Spark Electric','sub', 'Electrical', 'Marcus Lee',    'Demo data', false);

  -- Schedule: milestones + work chain ----------------------------------------
  -- Job Start / Substantial Completion are the two protected milestone rows
  -- every project carries (0069/0070); 1-day spans per the 0084 convention.
  -- Every successor starts exactly at its predecessor's end + 1 (the app's FS
  -- cascade math), and baseline dates mirror the current dates (the project is
  -- seeded baselined, so the health banner opens green with the full buffer).
  insert into schedule_items (id, project_id, kind, title, status, milestone,
                              start_date, end_date,
                              baseline_start_date, baseline_end_date,
                              duration_days, position, created_by)
  values
    (ms_start, v_project, 'work', 'Job Start',                'complete',    'job_start',              d - 21, d - 21, d - 21, d - 21, 1,  0,   p_owner),
    (w_site,   v_project, 'work', 'Site Prep & Excavation',   'complete',    null,                     d - 20, d - 16, d - 20, d - 16, 5,  10,  p_owner),
    (w_found,  v_project, 'work', 'Footings & Foundation',    'complete',    null,                     d - 15, d - 6,  d - 15, d - 6,  10, 20,  p_owner),
    (w_frame,  v_project, 'work', 'Framing',                  'in_progress', null,                     d - 5,  d + 10, d - 5,  d + 10, 16, 30,  p_owner),
    (w_roof,   v_project, 'work', 'Roofing',                  'not_started', null,                     d + 11, d + 17, d + 11, d + 17, 7,  40,  p_owner),
    (w_wind,   v_project, 'work', 'Windows & Exterior Doors', 'not_started', null,                     d + 11, d + 18, d + 11, d + 18, 8,  50,  p_owner),
    (w_plumb,  v_project, 'work', 'Plumbing Rough-In',        'not_started', null,                     d + 19, d + 25, d + 19, d + 25, 7,  60,  p_owner),
    (w_hvac,   v_project, 'work', 'HVAC Rough-In',            'not_started', null,                     d + 19, d + 25, d + 19, d + 25, 7,  70,  p_owner),
    (w_elec,   v_project, 'work', 'Electrical Rough-In',      'not_started', null,                     d + 26, d + 32, d + 26, d + 32, 7,  80,  p_owner),
    (w_insul,  v_project, 'work', 'Insulation',               'not_started', null,                     d + 33, d + 36, d + 33, d + 36, 4,  90,  p_owner),
    (w_dry,    v_project, 'work', 'Drywall',                  'not_started', null,                     d + 37, d + 46, d + 37, d + 46, 10, 100, p_owner),
    (w_trim,   v_project, 'work', 'Interior Trim & Doors',    'not_started', null,                     d + 47, d + 56, d + 47, d + 56, 10, 110, p_owner),
    (w_cab,    v_project, 'work', 'Cabinets & Countertops',   'not_started', null,                     d + 57, d + 64, d + 57, d + 64, 8,  120, p_owner),
    (w_paint,  v_project, 'work', 'Paint',                    'not_started', null,                     d + 65, d + 72, d + 65, d + 72, 8,  130, p_owner),
    (w_floor,  v_project, 'work', 'Flooring',                 'not_started', null,                     d + 73, d + 79, d + 73, d + 79, 7,  140, p_owner),
    (w_mep,    v_project, 'work', 'Final MEP Trim-Out',       'not_started', null,                     d + 80, d + 86, d + 80, d + 86, 7,  150, p_owner),
    (w_punch,  v_project, 'work', 'Punch List & Final Clean', 'not_started', null,                     d + 87, d + 93, d + 87, d + 93, 7,  160, p_owner),
    (ms_sub,   v_project, 'work', 'Substantial Completion',   'not_started', 'substantial_completion', d + 94, d + 94, d + 94, d + 94, 1,  170, p_owner);

  -- FS predecessor edges (dep_type defaults 'FS', lag 0)
  insert into schedule_predecessors (item_id, predecessor_id)
  values
    (w_site,  ms_start),
    (w_found, w_site),
    (w_frame, w_found),
    (w_roof,  w_frame),
    (w_wind,  w_frame),
    (w_plumb, w_roof), (w_plumb, w_wind),
    (w_hvac,  w_roof), (w_hvac,  w_wind),
    (w_elec,  w_plumb), (w_elec, w_hvac),
    (w_insul, w_elec),
    (w_dry,   w_insul),
    (w_trim,  w_dry),
    (w_cab,   w_trim),
    (w_paint, w_cab),
    (w_floor, w_paint),
    (w_mep,   w_floor),
    (w_punch, w_mep),
    (ms_sub,  w_punch);

  -- To-dos (one nested under Framing, two standalone; one with a checklist)
  insert into schedule_items (id, project_id, kind, title, status, parent_id,
                              due_date, priority, position, created_by)
  values
    (t_windows, v_project, 'todo', 'Order windows & exterior doors',      'not_started', null,    d + 3,  'high', 200, p_owner),
    (t_inspect, v_project, 'todo', 'Schedule framing inspection',         'not_started', w_frame, d + 8,  null,   210, p_owner),
    (t_walk,    v_project, 'todo', 'Walk electrical plan with homeowner', 'not_started', null,    d + 22, null,   220, p_owner);

  insert into todo_checklist_items (schedule_item_id, label, is_done, position)
  values
    (t_windows, 'Confirm sizes against plan set',  true,  0),
    (t_windows, 'Get lead time in writing',        false, 1),
    (t_windows, 'Schedule delivery date',          false, 2);

  -- Assignments: subs on their trades, one role-based, owner on the to-do
  insert into schedule_assignments (schedule_item_id, company_id)
  values (w_frame, c_fram), (w_plumb, c_plumb), (w_elec, c_elec);
  if r_hvac is not null then
    insert into schedule_assignments (schedule_item_id, role_id) values (w_hvac, r_hvac);
  end if;
  insert into schedule_assignments (schedule_item_id, profile_id) values (t_windows, p_owner);

  -- Project roles: owner is the PM; demo subs fill their trade roles
  if r_pm is not null then
    insert into project_role_members (project_id, role_id, profile_id, updated_by)
    values (v_project, r_pm, p_owner, p_owner);
  end if;
  if r_fram is not null then
    insert into project_role_members (project_id, role_id, company_id, updated_by)
    values (v_project, r_fram, c_fram, p_owner);
  end if;
  if r_plumb is not null then
    insert into project_role_members (project_id, role_id, company_id, updated_by)
    values (v_project, r_plumb, c_plumb, p_owner);
  end if;
  if r_elec is not null then
    insert into project_role_members (project_id, role_id, company_id, updated_by)
    values (v_project, r_elec, c_elec, p_owner);
  end if;

  -- Decisions ------------------------------------------------------------------
  -- #1: a selection waiting on the client (the "how decisions work" showcase).
  -- price_delta per choice = raw cost × (1 + markup). cost_delta stays null
  -- until a choice is approved — matching the app's computation.
  insert into decisions (id, project_id, kind, number, title, description,
                         status, due_date, markup_percent, created_by)
  values (d_counter, v_project, 'selection', 1, 'Kitchen countertop selection',
          'Pick the kitchen countertop material so fabrication can be scheduled '
          || 'ahead of the cabinet install.',
          'pending_client', d + 10, 15, p_owner);

  insert into decision_choices (id, decision_id, title, description, position, price_delta)
  values
    (ch_quartz, d_counter, 'Quartz — calacatta style',
     'Engineered quartz, full-height splash at the range.', 0, 7820.00),
    (ch_gran,   d_counter, 'Granite — level 2',
     'Natural stone from the level-2 yard selection.', 1, 6325.00),
    (ch_butch,  d_counter, 'Butcher block — island only',
     'Maple butcher block on the island, quartz on the perimeter.', 2, 3220.00);

  insert into decision_cost_items (decision_id, choice_id, cost_code_id,
                                   description, quantity, unit, unit_cost, position)
  values
    (d_counter, ch_quartz, cc_counter, 'Quartz slabs + fabrication + install', 1, 'ls', 6800.00, 0),
    (d_counter, ch_gran,   cc_counter, 'Granite slabs + fabrication + install', 1, 'ls', 5500.00, 0),
    (d_counter, ch_butch,  cc_counter, 'Butcher block island + quartz perimeter', 1, 'ls', 2800.00, 0);

  -- #2: a draft change order (staff-side pricing not yet sent to the client).
  -- cost_delta = (4200 + 3500) × 1.15 = 8855.00, matching its line items.
  insert into decisions (id, project_id, kind, number, title, description,
                         status, markup_percent, cost_delta, created_by)
  values (d_patio, v_project, 'change_order', 2, 'Add covered rear patio',
          'Homeowner asked about covering the rear patio — rough pricing for '
          || 'review before sending.',
          'draft', 15, 8855.00, p_owner);

  insert into decision_cost_items (decision_id, cost_code_id, description,
                                   quantity, unit, unit_cost, position)
  values
    (d_patio, cc_slab,    'Patio slab + footings',              1, 'ls', 4200.00, 0),
    (d_patio, cc_framing, 'Roof extension framing + shingles',  1, 'ls', 3500.00, 1);

  -- Daily logs -----------------------------------------------------------------
  insert into daily_logs (id, project_id, log_date, visibility, notes, created_by)
  values
    (dl_client, v_project, d - 3, 'client',
     'Foundation inspection passed this morning — footings and stem walls '
     || 'signed off. Framing package delivers Monday.', p_owner),
    (dl_internal, v_project, d - 1, 'internal',
     'Summit framing crew of five on site. First-floor exterior walls framed '
     || 'and braced by end of day. Weather looks clear through the week — '
     || 'second-floor decking starts tomorrow.', p_owner);

  insert into daily_log_subs_on_site (daily_log_id, company_id, notes)
  values (dl_internal, c_fram, 'Crew of 5 — wall framing');

  return v_project;
end;
$$;

revoke all on function seed_demo_project(uuid, uuid) from public;
revoke execute on function seed_demo_project(uuid, uuid) from anon;
revoke execute on function seed_demo_project(uuid, uuid) from authenticated;
grant execute on function seed_demo_project(uuid, uuid) to service_role;

comment on function public.seed_demo_project(uuid, uuid) is
  'Seeds one purpose-built sample project (schedule, decisions, daily logs, demo subs) into an org with ZERO projects; no-op otherwise. Called by create_sandbox_organization for trials; service-role only.';

-- 2. Wire into trial provisioning (non-fatal) --------------------------------

create or replace function public.create_sandbox_organization(
  p_name text,
  p_slug text,
  p_owner uuid,
  p_trial_days integer default 7
) returns table (org_id uuid, expires_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  new_org uuid;
  v_expires timestamptz;
begin
  if p_trial_days is null or p_trial_days < 1 or p_trial_days > 365 then
    raise exception 'Trial length must be between 1 and 365 days.';
  end if;

  -- Reuse the provisioning path: org row + owner enrollment + active cost
  -- codes/roles seeded from Hines (org #1, the create_organization default).
  -- Runs in THIS function's transaction — the stamp below rides along, so a
  -- created sandbox org always carries its trial status + expiry.
  new_org := public.create_organization(p_name, p_slug, p_owner);

  v_expires := now() + make_interval(days => p_trial_days);

  update public.organizations
     set status = 'sandbox_active',
         sandbox_expires_at = v_expires
   where id = new_org;

  -- Demo project (0120): a trial should open on a working sample job, not an
  -- empty workspace. Strictly best-effort — a seed failure must never fail
  -- the signup, so swallow it (the trial just starts empty, and the warning
  -- reaches the DB logs for us to investigate).
  begin
    perform public.seed_demo_project(new_org, p_owner);
  exception when others then
    raise warning 'demo project seed failed for org %: %', new_org, sqlerrm;
  end;

  return query select new_org, v_expires;
end;
$$;

-- Re-assert the 0117 grants (create or replace keeps ACLs, but be explicit).
revoke all on function create_sandbox_organization(text, text, uuid, integer) from public;
revoke execute on function create_sandbox_organization(text, text, uuid, integer) from anon;
revoke execute on function create_sandbox_organization(text, text, uuid, integer) from authenticated;
grant execute on function create_sandbox_organization(text, text, uuid, integer) to service_role;

comment on function public.create_sandbox_organization(text, text, uuid, integer) is
  'Atomic self-serve trial provisioning: create_organization() seeded from Hines, stamp status=sandbox_active + sandbox_expires_at, then best-effort seed_demo_project(). Service-role only.';

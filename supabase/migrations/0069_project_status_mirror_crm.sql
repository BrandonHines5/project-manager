-- Make PM's project_status enum mirror the Hines Homes CRM's statuses 1:1
-- (Upcoming, In Work, Complete, Warranty, Inventory, Paused, Cancelled).
--
-- Until now PM kept its own vocabulary (lead, pre_construction, active,
-- on_hold, …) and the CRM sync translated between the two — so the same job
-- read "Pre-construction" here and "Upcoming" in the CRM, and CRM statuses
-- like Inventory had no local value at all (they collapsed into 'active').
-- One vocabulary ends that: each enum value IS a CRM status (snake_cased),
-- and lib/crm-status.ts becomes a 1:1 word mapping.
--
-- Row remap: when a row has a recognised crm_status (previously synced from
-- the CRM) that word wins — it's the ground truth this change is about, and
-- it recovers distinctions the old enum flattened (an 'active' row synced as
-- "Inventory" becomes 'inventory'). Un-synced rows map by retired value:
-- lead/pre_construction → upcoming, active → in_work, on_hold → paused.

alter type public.project_status rename to project_status_old;

create type public.project_status as enum
  ('upcoming', 'in_work', 'complete', 'warranty', 'inventory', 'paused', 'cancelled');

alter table public.projects
  alter column status drop default;

alter table public.projects
  alter column status type public.project_status
  using (
    case
      when replace(lower(trim(coalesce(crm_status, ''))), ' ', '_') in
        ('upcoming', 'in_work', 'complete', 'warranty', 'inventory', 'paused', 'cancelled')
        then replace(lower(trim(crm_status)), ' ', '_')
      when status::text in ('lead', 'pre_construction') then 'upcoming'
      when status::text = 'active' then 'in_work'
      when status::text = 'on_hold' then 'paused'
      else status::text
    end
  )::public.project_status;

-- Same default a new job effectively got before ('active' ≙ 'in_work').
alter table public.projects
  alter column status set default 'in_work';

drop type public.project_status_old;

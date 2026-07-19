-- 0103: Stage B2 module 4 — org-scope app_settings.
--
-- app_settings rows (template_tag_groups, delay_reasons, budget_editors,
-- decision_disclaimer, invoice_payment_recipients, qbo_push_defaults) become
-- per-org: the read policy keeps its shape (clients may read only the
-- decision disclaimer, staff read the rest) but both policies gain the org
-- condition, so a user only ever sees their own org's settings row per key.
-- Every user belongs to one org, so existing `.eq("key", …).maybeSingle()`
-- reads keep returning at most one row with zero code changes; the write
-- sites switch to `onConflict: "org_id,key"` and stamp org_id explicitly
-- (companion code change), and the admin-client reader (QBO webhook) filters
-- by the connection's org.
--
-- The legacy single-org uniqueness was the PRIMARY KEY (key). Multi-org
-- correctness needs (org_id, key), which 0099 staged as the unique index
-- app_settings_org_key_idx — promote that index to be the primary key and
-- drop the old one. Nothing references app_settings by FK, so the PK swap
-- has no downstream constraints to re-point.

alter table app_settings drop constraint app_settings_pkey;
alter table app_settings
  add constraint app_settings_pkey primary key using index app_settings_org_key_idx;

-- Policies gain the org condition (same shapes as before otherwise).

drop policy app_settings_read_all on app_settings;
create policy app_settings_read_all on app_settings
  for select to authenticated
  using (
    (key = 'decision_disclaimer' or is_staff())
    and is_org_member(org_id)
  );

drop policy app_settings_staff_write on app_settings;
create policy app_settings_staff_write on app_settings
  as permissive for all
  using (is_staff() and is_org_member(org_id))
  with check (is_staff() and is_org_member(org_id));

-- Bridge default off — every write site stamps org_id explicitly from this
-- migration's companion code change.

alter table app_settings alter column org_id drop default;

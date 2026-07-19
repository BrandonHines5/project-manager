-- 0104: Stage B2 module 5 — org-scope communications.
--
-- The staff policy was a bare is_staff(), so staff of ANY org could read the
-- whole global hub (and update/insert rows). It gains the org condition here;
-- the client/trade read policies are untouched — they're already row-scoped
-- (profile_id = auth.uid() + project membership; company_id =
-- current_company_id()).
--
-- Writes are a different story from the other modules: EVERY communications
-- insert runs on the admin client (lib/comms/log.ts is the shared funnel —
-- webhook/cron/token call sites have no session), so RLS can't stamp org for
-- us. The companion code change stamps org_id explicitly wherever the org is
-- knowable: compose/reply actions from the acting session or the thread row,
-- client compose from the membership-validated project, and logCommunication
-- itself resolves project_id → projects.org_id / company_id →
-- companies.org_id when the call site didn't pass one.
--
-- The bridge default STAYS (like insurance_documents in 0101): the inbound
-- channels (Quo webhook, Resend inbound, Outlook sync cron) are env-singleton
-- Hines integrations until Stage B4 — a fully unattributed inbound row has no
-- org to resolve and correctly lands on the default. B4 drops the default
-- when those channels resolve their org per-integration.

drop policy comms_staff_all on communications;
create policy comms_staff_all on communications
  as permissive for all
  using (is_staff() and is_org_member(org_id))
  with check (is_staff() and is_org_member(org_id));

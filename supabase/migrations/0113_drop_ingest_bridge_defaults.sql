-- 0113: Stage B4 (part 2) — drop two more 0099 bridge defaults.
--
-- insurance_documents: every ingest path now stamps org_id explicitly —
-- the sub token upload stamps the token company's org, staff manual upload
-- stamps the acting staffer's active org, and the inbound-email webhook
-- resolves the org from the recipient's plus-tag (insurance+{org-slug}@…,
-- untagged legacy mail files to org #1 via LEGACY_ORG_ID).
--
-- utility_requests: the single insert path (saveUtilityDrafts) stamps the
-- acting staffer's active org.
--
-- With the defaults gone, a new write path that forgets org_id fails with
-- a NOT NULL violation instead of silently landing in Hines' tenant.
-- communications keeps its bridge default until the Quo slice makes
-- inbound phone traffic org-resolvable (per-org numbers).

alter table insurance_documents alter column org_id drop default;
alter table utility_requests    alter column org_id drop default;

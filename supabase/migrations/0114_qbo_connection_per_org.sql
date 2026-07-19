-- 0114: Stage B4 (part 3) — qbo_connection becomes truly per-org.
--
-- One Intuit app serves the whole platform (client id/secret + webhook
-- verifier stay env singletons); what's per-org is the CONNECTION — each org
-- OAuth-connects its own QBO company (realm). The code now reads
-- connections by org (staff paths resolve the active org) or by realm (the
-- webhook: Intuit events carry realmId, the row carries org_id), and the
-- OAuth callback stamps the connecting staffer's org — refusing a realm
-- that already belongs to a different org.
--
-- With the save path stamping explicitly, the 0099 bridge default drops: a
-- connection write that forgets its org now fails loudly instead of
-- silently filing under Hines.

alter table qbo_connection alter column org_id drop default;

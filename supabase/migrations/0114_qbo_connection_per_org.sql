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

-- Exactly ONE connection per org, enforced by the database. Pre-existing
-- duplicates (an org's old test-company connection alongside its current
-- one) keep only the newest row per org — which is exactly the row the old
-- latest-first read already resolved, so behavior doesn't change; the older
-- rows were unreachable. saveQboConnection replaces an org's prior
-- connection on a company switch, and this index makes any race between
-- two connects fail loudly instead of leaving two rows.
delete from qbo_connection
where realm_id not in (
  -- realm_id desc breaks updated_at ties deterministically (the table has
  -- no surrogate id; realm_id is the PK).
  select distinct on (org_id) realm_id
  from qbo_connection
  order by org_id, updated_at desc, realm_id desc
);
create unique index if not exists qbo_connection_org_key
  on qbo_connection (org_id);

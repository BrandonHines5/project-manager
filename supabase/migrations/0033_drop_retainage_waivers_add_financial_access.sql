-- Three changes for a single pass.
--
-- 1. Hines Homes doesn't use retainage on its contracts. The
--    retainage_percent column added in 0027 produced UI noise (the
--    "Balance due (after X% retainage)" label, the info row, the
--    edit-project field) without ever holding a non-zero value
--    (verified: zero projects had retainage > 0 at the time of this
--    migration). Drop it.
--
-- 2. Similarly, the lien_waiver_received / lien_waiver_reference
--    columns on project_payments (also from 0027) were never used and
--    produced a "missing waiver" warning on the pricing page for every
--    payment. Drop both columns and the associated partial index.
--
-- 3. Add profiles.financial_access — a per-staff boolean used to gate
--    the Contract value + Cost growth cards on the /projects portfolio
--    dashboard. Defaults false; we set Brandon to true so he can see
--    his own dashboard. Future grants happen via the Team UI.

alter table public.projects
  drop column if exists retainage_percent;

drop index if exists public.idx_pp_waiver_missing;
alter table public.project_payments
  drop column if exists lien_waiver_received,
  drop column if exists lien_waiver_reference;

alter table public.profiles
  add column if not exists financial_access boolean not null default false;

update public.profiles
  set financial_access = true
  where id = 'c7c1b77b-cbf0-47b9-b934-358b1b6c4d66';

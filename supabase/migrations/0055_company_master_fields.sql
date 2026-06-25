-- =====================================================================
-- 0055 — Company master-list fields + per-company notification toggle
-- =====================================================================
-- The sub/vendor master list carries more than the original companies table
-- modeled: a primary contact, a second phone, a hire status, structured
-- city/state/zip, and a web page. Add those columns so the import has a home
-- and the Companies UI can show/edit them.
--
-- Plus `notifications_enabled`: a per-company switch (mirrors
-- profiles.notifications_enabled from 0036). When false, assignment
-- notifications (the SMS/email a sub gets when added to a schedule item) are
-- suppressed — used to keep the imported subs quiet while the app is still in
-- testing. Defaults true so existing companies are unaffected.

alter table public.companies
  add column if not exists contact_name text,
  add column if not exists phone_secondary text,
  add column if not exists city text,
  add column if not exists state text,
  add column if not exists postal_code text,
  add column if not exists website text,
  add column if not exists status text,
  add column if not exists notifications_enabled boolean not null default true;

comment on column public.companies.contact_name is
  'Primary contact person at the company.';
comment on column public.companies.phone_secondary is
  'Secondary phone number.';
comment on column public.companies.status is
  'Hire/relationship status from the master list (e.g. "Approved for Use", '
  '"Not for Hire", "Inactive", "Interviewed", "Not Contacted"). Free text — '
  'the set is open and maintained by staff.';
comment on column public.companies.notifications_enabled is
  'When false, this company is NOT sent assignment notifications (SMS/email) '
  'when added to a schedule item. Defaults true; set false to keep a company '
  'quiet (e.g. imported subs during testing).';

-- Filtering the Companies list by status is a likely UI need; a small index
-- keeps it cheap as the list grows past a few hundred rows.
create index if not exists idx_companies_status on public.companies(status);

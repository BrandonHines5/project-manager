-- =====================================================================
-- 0091 — Company AKA + insurance agent contact + insurance doc kinds
-- =====================================================================
-- Three related directory/insurance upgrades:
--   * companies.aka — "Also Known As". `name` stays the OFFICIAL legal name
--     (what appears on payments and insurance certificates); `aka` is the
--     everyday name staff know them by, which may show up on invoices and
--     other communication. Surfaced in search and used by COI auto-matching.
--   * companies.insurance_agent_* — the sub's insurance AGENCY/agent contact
--     (the ACORD "Producer"). Saved so insurance requests can go to the
--     agent as well as the sub; auto-filled from certificate extraction when
--     blank.
--   * insurance_documents.doc_kind — the insurance page now stores W9s and
--     Subcontractor Master Agreements (SMAs) alongside COIs. Non-COI kinds
--     skip Claude extraction and never materialize policy rows.

alter table public.companies
  add column if not exists aka text,
  add column if not exists insurance_agent_name text,
  add column if not exists insurance_agent_email text,
  add column if not exists insurance_agent_phone text;

comment on column public.companies.aka is
  'Also Known As — the everyday name staff use for this company. `name` is '
  'the official/legal name used on payments and insurance.';
comment on column public.companies.insurance_agent_name is
  'The sub''s insurance agency/agent (ACORD Producer). Requests for updated '
  'certificates are CC''d here when an email is on file.';

alter table public.insurance_documents
  add column if not exists doc_kind text not null default 'coi';

-- Add the CHECK separately so re-runs are idempotent even if the column
-- already existed without it.
do $$ begin
  alter table public.insurance_documents
    add constraint insurance_documents_doc_kind_check
    check (doc_kind in ('coi', 'w9', 'sma'));
exception when duplicate_object then null; end $$;

comment on column public.insurance_documents.doc_kind is
  'coi = certificate of insurance (extracted into insurance_policies); '
  'w9 / sma = plain stored documents (no extraction).';

create index if not exists idx_insdoc_kind
  on public.insurance_documents(doc_kind);

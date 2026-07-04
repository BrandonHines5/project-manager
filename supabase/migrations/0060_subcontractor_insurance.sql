-- =====================================================================
-- 0060 — Subcontractor insurance tracking (COIs: GL + workers comp)
-- =====================================================================
-- Tracks certificates of insurance for subs/vendors:
--   * insurance_documents — one row per ingested COI file (emailed in via
--     the Resend inbound webhook, uploaded by the sub through their
--     tokenized upload link, or uploaded manually by staff). The file
--     itself lives in the private `project-files` bucket under
--     companies/insurance/…; extraction status + the raw email metadata
--     live here so the "needs review" queue can show where a doc came from.
--   * insurance_policies — one row per policy parsed off a COI (a single
--     ACORD 25 usually lists general liability + workers comp + auto +
--     umbrella). The "current" policy for a company+type is simply the one
--     with the latest expiration_date; superseded rows are kept as history.
--   * companies.insurance_upload_token — a stable per-company secret used
--     to build the public upload link mailed to subs when a policy is
--     about to lapse. The token only allows POSTING a new certificate
--     (server-side, via the admin client) — it can't read anything.
--
-- Access: staff only. Clients and trades have no access to insurance data;
-- subs interact exclusively through the tokenized upload endpoint, which
-- runs server-side with the service role after validating the token.

do $$ begin
  create type insurance_type as enum
    ('general_liability', 'workers_comp', 'auto', 'umbrella');
exception when duplicate_object then null; end $$;

-- ----- documents -----------------------------------------------------
create table if not exists public.insurance_documents (
  id uuid primary key default gen_random_uuid(),
  -- Null until we've matched the cert to a company (email ingestion can't
  -- always tell who sent it) — those rows form the "needs review" queue.
  company_id uuid references public.companies(id) on delete set null,
  storage_bucket text not null default 'project-files',
  storage_path text not null,
  file_name text not null,
  file_type text,
  file_size bigint,
  source text not null check (source in ('email', 'upload', 'manual')),
  email_from text,
  email_subject text,
  received_at timestamptz not null default now(),
  status text not null default 'pending'
    check (status in ('pending', 'processed', 'needs_review', 'failed')),
  -- The insured's name as Claude read it off the certificate. Kept so the
  -- review queue can show "cert says 'ABC Plumbing LLC'" next to the
  -- company picker when auto-matching failed.
  extracted_company_name text,
  extraction_error text,
  -- Raw structured extraction from Claude (company_name + policies[]). Kept
  -- so a needs_review doc can be assigned to a company later without
  -- re-running the model.
  extraction jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_insdoc_company on public.insurance_documents(company_id);
create index if not exists idx_insdoc_status  on public.insurance_documents(status);

-- ----- policies ------------------------------------------------------
create table if not exists public.insurance_policies (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  document_id uuid references public.insurance_documents(id) on delete set null,
  type insurance_type not null,
  carrier text,
  policy_number text,
  effective_date date,
  expiration_date date not null,
  -- Coverage limits as extracted, e.g. {"each_occurrence": 1000000,
  -- "general_aggregate": 2000000}. Jsonb because the interesting limit
  -- fields differ per policy type and we only display them.
  limits jsonb,
  -- Stamped when the expiration-reminder cron emails the sub about THIS
  -- policy, so the daily run never double-sends for the same policy.
  reminder_sent_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_inspol_company_type
  on public.insurance_policies(company_id, type, expiration_date desc);
create index if not exists idx_inspol_expiration
  on public.insurance_policies(expiration_date);
create index if not exists idx_inspol_document
  on public.insurance_policies(document_id);
-- Backstop against ingesting the same cert twice (e.g. the sub emails the
-- same PDF two days in a row). App code also checks before inserting.
create unique index if not exists uq_inspol_dedup
  on public.insurance_policies(company_id, type, coalesce(policy_number, ''), expiration_date);

-- ----- per-company upload token --------------------------------------
alter table public.companies
  add column if not exists insurance_upload_token uuid not null default gen_random_uuid();
create unique index if not exists uq_companies_insurance_token
  on public.companies(insurance_upload_token);
comment on column public.companies.insurance_upload_token is
  'Secret for the public /insurance-upload/{token} page mailed to subs. '
  'Grants upload-only access; regenerate by updating to gen_random_uuid().';

-- ----- RLS ------------------------------------------------------------
alter table public.insurance_documents enable row level security;
alter table public.insurance_policies  enable row level security;

drop policy if exists insdoc_staff_all on public.insurance_documents;
create policy insdoc_staff_all on public.insurance_documents
  for all using (public.is_staff()) with check (public.is_staff());

drop policy if exists inspol_staff_all on public.insurance_policies;
create policy inspol_staff_all on public.insurance_policies
  for all using (public.is_staff()) with check (public.is_staff());

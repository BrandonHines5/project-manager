-- Retainage tracking. Custom-home contracts routinely hold back 5–10% of the
-- contract until punchlist completion; without a first-class column the PM
-- can't compute "balance due minus retainage" without doing it in their
-- head. Stored as a percent so a project that lifts retainage to 0% on
-- closeout doesn't need a separate "amount" column rewritten.
--
-- Range 0–25 covers every realistic case; the CHECK constraint catches the
-- "I typed 100 by mistake" finger-fumble.

alter table public.projects
  add column if not exists retainage_percent numeric(5,2) not null default 0
    check (retainage_percent >= 0 and retainage_percent <= 25);

-- Lien waiver tracking on payments. Many builders require subs to sign a
-- waiver before each disbursement so the GC can prove materials/labor for
-- that payment were paid up. Tracked per-payment with a free-text
-- reference (could be a check number, DocuSign envelope, or "see filing
-- cabinet folder 2026-001"). Receipt boolean drives the UI badge.

alter table public.project_payments
  add column if not exists lien_waiver_received boolean not null default false,
  add column if not exists lien_waiver_reference text;

create index if not exists idx_pp_waiver_missing
  on public.project_payments(project_id)
  where deleted_at is null and not lien_waiver_received;

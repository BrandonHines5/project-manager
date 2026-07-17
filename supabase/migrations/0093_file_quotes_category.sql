-- =====================================================================
-- 0093 — Add 'quotes' to file_category
-- =====================================================================
-- Kept as its own migration on purpose: ALTER TYPE ... ADD VALUE can run
-- inside a transaction, but the new value can't be REFERENCED in the same
-- transaction — so nothing else may ride along here.

alter type file_category add value if not exists 'quotes';

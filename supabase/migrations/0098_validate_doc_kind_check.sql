-- 0098: validate the doc_kind constraint added NOT VALID in 0097.
-- Separate migration = separate transaction, so the validation scan never
-- runs under 0097's ALTER TABLE lock.

alter table public.insurance_documents
  validate constraint insurance_documents_doc_kind_check;

-- 0097: Vendor Documents — auto-classified doc kinds
--
-- The Claude extractor now CLASSIFIES every ingested document (COI / W9 /
-- SMA) instead of staff picking the type up front. Anything the classifier
-- can't recognize is stored honestly as 'other' — it lands in the review
-- queue where staff can correct the kind and assign a company — rather than
-- masquerading as a COI.

alter table public.insurance_documents
  drop constraint if exists insurance_documents_doc_kind_check;

-- NOT VALID + VALIDATE keeps the table scan outside the write-blocking
-- lock (the table is tiny today, but the pattern costs nothing).
alter table public.insurance_documents
  add constraint insurance_documents_doc_kind_check
  check (doc_kind in ('coi', 'w9', 'sma', 'other')) not valid;

alter table public.insurance_documents
  validate constraint insurance_documents_doc_kind_check;

comment on column public.insurance_documents.doc_kind is
  'coi = certificate of insurance (extraction + policy rows), w9 = IRS Form W-9, sma = Subcontractor Master Agreement, other = auto-classifier could not recognize the document.';

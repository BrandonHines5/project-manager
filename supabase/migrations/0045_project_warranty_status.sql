-- Warranty phase. After a home is complete it enters a warranty period where
-- the homeowner reports issues we still have to resolve. Model it as a new
-- lifecycle status that sits right after 'complete', so a project can be moved
-- to warranty and its remaining open to-dos tracked as the warranty punch list.
--
-- ADD VALUE ... AFTER keeps the enum's natural sort order sensible
-- (… complete → warranty → cancelled).

alter type project_status add value if not exists 'warranty' after 'complete';

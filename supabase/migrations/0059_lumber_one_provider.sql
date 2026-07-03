-- Initiate Utilities: add Lumber One as a second provider.
--
-- Starting a job also means opening it with the lumber yard: the "New Job
-- Set-Up Request Form" is filled and emailed to Lumber One (Brad Hartwick).
-- Lumber One requests reuse the utility_requests machinery but have no
-- pay-by-link steps — their workflow is draft -> submitted -> complete.

alter type public.utility_provider add value if not exists 'lumber_one';

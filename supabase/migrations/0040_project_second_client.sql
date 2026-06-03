-- Second client, mirrored from the Hines Homes Dashboard.
--
-- The dashboard tracks up to two clients per project (client + client_2,
-- each resolved from its `clients` table). PM previously stored only one.
-- These columns mirror the dashboard's second slot so the project header can
-- list every client with their email + phone. Dashboard-owned, like the
-- first client's fields and project_manager.

alter table public.projects
  add column if not exists client_name_2 text,
  add column if not exists client_email_2 text,
  add column if not exists client_phone_2 text;

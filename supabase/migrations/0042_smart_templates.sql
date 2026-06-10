-- Smart templates: conditionally include template items based on house
-- attributes answered at project creation.
--
-- * projects.attributes — jsonb map of boolean answers captured when the
--   project was created from a template (e.g. {"walkout": true,
--   "finished_basement": false}). Empty for blank/dashboard-only projects.
-- * schedule_items.template_tags / decisions.template_tags — conditions a
--   template item carries. An item with no tags always copies. A tag like
--   'walkout' requires the answer to be true; '!walkout' requires false.
--   Multiple tags must ALL match. Tags are inert outside duplication.
--
-- Both columns are plain data — existing RLS policies on the tables cover
-- them; no policy changes needed.

alter table public.projects
  add column if not exists attributes jsonb not null default '{}'::jsonb;

alter table public.schedule_items
  add column if not exists template_tags text[] not null default '{}';

alter table public.decisions
  add column if not exists template_tags text[] not null default '{}';

comment on column public.projects.attributes is
  'Boolean house-attribute answers captured when duplicating from a template (e.g. {"walkout": true}). Drives which template_tags-conditioned items were copied.';
comment on column public.schedule_items.template_tags is
  'Template conditions: copy this item only when every tag matches the new project''s attributes. ''walkout'' requires true, ''!walkout'' requires false. Empty = always copy.';
comment on column public.decisions.template_tags is
  'Template conditions: copy this decision only when every tag matches the new project''s attributes. ''walkout'' requires true, ''!walkout'' requires false. Empty = always copy.';

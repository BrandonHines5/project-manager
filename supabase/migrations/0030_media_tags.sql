-- Photo gallery tagging. The review flagged "finding a 3-month-old photo of
-- a foundation crack" as the worst day-to-day pain on this app — date-
-- ordered scroll is the only tool, and substring search on captions misses
-- everything that wasn't typed exactly. Give each media item a tag set so
-- a PM can land on "foundation" or "rough-in/electrical" in two clicks.
--
-- Tags are a text[] column on each attachment table. A junction table would
-- be cleaner, but the four sources (project_files, daily_log_attachments,
-- decision_attachments, schedule_item_attachments) all want the same
-- vocabulary and a flat array + GIN index gives single-statement filter
-- ("tag = ?" → "tags @> array[tag]"). 20-tag cap per file, lower-cased
-- 1..40 chars, enforced via a per-table trigger so the constraint stays
-- consistent across sources without duplicating CHECK logic.

create or replace function public.validate_media_tags(p_tags text[])
returns void
language plpgsql
as $$
declare
  v text;
begin
  if p_tags is null then
    return;
  end if;
  if array_length(p_tags, 1) > 20 then
    raise exception 'at most 20 tags per attachment';
  end if;
  foreach v in array p_tags loop
    if char_length(v) < 1 or char_length(v) > 40 then
      raise exception 'each tag must be 1..40 chars (got %)', length(v);
    end if;
    if v <> lower(v) then
      raise exception 'tags must be lower-cased (got %)', v;
    end if;
    if trim(v) <> v then
      raise exception 'tags may not have leading/trailing whitespace';
    end if;
  end loop;
end;
$$;

create or replace function public.tags_before_write()
returns trigger
language plpgsql
as $$
begin
  perform public.validate_media_tags(new.tags);
  return new;
end;
$$;

alter table public.daily_log_attachments
  add column if not exists tags text[] not null default '{}';
create index if not exists idx_dla_tags
  on public.daily_log_attachments using gin (tags);
drop trigger if exists trg_dla_tags on public.daily_log_attachments;
create trigger trg_dla_tags
  before insert or update of tags on public.daily_log_attachments
  for each row execute function public.tags_before_write();

alter table public.decision_attachments
  add column if not exists tags text[] not null default '{}';
create index if not exists idx_da_tags
  on public.decision_attachments using gin (tags);
drop trigger if exists trg_da_tags on public.decision_attachments;
create trigger trg_da_tags
  before insert or update of tags on public.decision_attachments
  for each row execute function public.tags_before_write();

alter table public.project_files
  add column if not exists tags text[] not null default '{}';
create index if not exists idx_pf_tags
  on public.project_files using gin (tags);
drop trigger if exists trg_pf_tags on public.project_files;
create trigger trg_pf_tags
  before insert or update of tags on public.project_files
  for each row execute function public.tags_before_write();

alter table public.schedule_item_attachments
  add column if not exists tags text[] not null default '{}';
create index if not exists idx_sia_tags
  on public.schedule_item_attachments using gin (tags);
drop trigger if exists trg_sia_tags on public.schedule_item_attachments;
create trigger trg_sia_tags
  before insert or update of tags on public.schedule_item_attachments
  for each row execute function public.tags_before_write();

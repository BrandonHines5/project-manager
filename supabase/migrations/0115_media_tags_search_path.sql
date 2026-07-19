-- 0115: B6 hardening — pin search_path on the media-tag functions.
--
-- validate_media_tags / tags_before_write (0030) were the last two
-- function_search_path_mutable advisor WARNs: a function without a fixed
-- search_path resolves unqualified names against the caller's search_path,
-- which a malicious role could repoint. Both already schema-qualify every
-- reference (`public.validate_media_tags`, and only built-ins otherwise), so
-- pinning search_path is pure hardening with zero behavior change — it just
-- closes the advisor finding. Bodies are re-stated verbatim (CREATE OR
-- REPLACE can't add SET to an existing function otherwise).

create or replace function public.validate_media_tags(p_tags text[])
returns void
language plpgsql
set search_path to 'public'
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
set search_path to 'public'
as $$
begin
  perform public.validate_media_tags(new.tags);
  return new;
end;
$$;

-- upsert_org_integration (0112) was created without a pinned search_path —
-- same finding, same fix. Re-stated verbatim + SET; grants are unchanged and
-- survive CREATE OR REPLACE.
create or replace function public.upsert_org_integration(
  p_org uuid,
  p_provider text,
  p_enabled boolean default null,
  p_config jsonb default null,
  p_secrets jsonb default null,
  p_touch_secrets boolean default false
) returns void
language sql
set search_path to 'public'
as $$
  insert into org_integrations (org_id, provider, enabled, config, secrets)
  values (
    p_org,
    p_provider,
    coalesce(p_enabled, true),
    coalesce(p_config, '{}'::jsonb),
    case when p_touch_secrets then p_secrets else null end
  )
  on conflict (org_id, provider) do update set
    enabled = coalesce(p_enabled, org_integrations.enabled),
    config = coalesce(p_config, org_integrations.config),
    secrets = case
      when p_touch_secrets then p_secrets
      else org_integrations.secrets
    end,
    updated_at = now();
$$;

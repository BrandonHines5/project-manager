-- 0109: Stage B5 (part 2) — org brand-asset storage.
--
-- The /settings/organization editor lets an org's owner/admin members upload
-- their own logos. Uploads land in the PUBLIC `brand-assets` bucket under a
-- per-org prefix ({org_id}/...). The bucket is public on purpose: brand marks
-- render where no session exists — the tokenized PO/bid pages' og:image and
-- link previews, and outbound email headers — and signed URLs expire, which
-- would rot every stored brand config. Logos are not sensitive; WRITES are
-- what's guarded, and only an org's own owner/admin members can touch that
-- org's prefix.

insert into storage.buckets (id, name, public)
  values ('brand-assets', 'brand-assets', true)
  on conflict (id) do nothing;

-- Owner/admin members manage objects under their OWN org's prefix. The
-- membership subquery sees the caller's own organization_members rows through
-- the member-read policy, and the text comparison sidesteps uuid casts on
-- arbitrary object paths (a malformed path simply matches nothing).
drop policy if exists brand_assets_admin_all on storage.objects;
create policy brand_assets_admin_all on storage.objects
  for all using (
    bucket_id = 'brand-assets'
    and exists (
      select 1 from public.organization_members m
      where m.profile_id = auth.uid()
        and m.member_role in ('owner', 'admin')
        and (storage.foldername(name))[1] = m.org_id::text
    )
  )
  with check (
    bucket_id = 'brand-assets'
    and exists (
      select 1 from public.organization_members m
      where m.profile_id = auth.uid()
        and m.member_role in ('owner', 'admin')
        and (storage.foldername(name))[1] = m.org_id::text
    )
  );

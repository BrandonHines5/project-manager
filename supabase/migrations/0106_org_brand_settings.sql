-- 0106: Stage B3 (part 1) — seed org #1's brand settings.
--
-- lib/brand.ts now resolves client-facing branding from
-- `organizations.settings.brands` (parseBrandConfig): a `default` brand plus
-- an optional `commercial` sub-brand that commercial project types present
-- under. This seeds org #1 with the exact values the code used to hardcode
-- (Hines Homes default, MJV Building Group commercial), so nothing
-- user-visible changes. Orgs without a brands block render a neutral
-- app-branded default carrying the org's name — never another org's logos.
-- Asset paths still point at /public; per-org logo upload into Storage comes
-- with the org-settings editor (B5 admin UI).

update organizations
set settings = jsonb_set(
  settings,
  '{brands}',
  '{
    "default": {
      "key": "hines",
      "name": "Hines Homes",
      "mark": "/brand/hines-mark.svg",
      "logo": "/brand/hines-logo.svg",
      "icon": "/icon-512.png"
    },
    "commercial": {
      "key": "mjv",
      "name": "MJV Building Group",
      "mark": "/brand/mjv-logo.svg",
      "logo": "/brand/mjv-logo.svg",
      "icon": "/brand/mjv-icon.png"
    }
  }'::jsonb,
  true
)
where id = '018f6f2a-4c1e-4b8e-9d3a-7c5b2e8a1f10';

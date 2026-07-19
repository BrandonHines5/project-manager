# Multi-tenant (Path B) — working plan

Goal: one deployment, one database, many builders ("orgs"). Hines Homes is org
#1 and must keep working unchanged at every stage. Every stage is additive,
independently shippable, and reversible; nothing user-visible changes until the
stage that deliberately changes it.

Canonical Hines org id (seeded in 0099): `018f6f2a-4c1e-4b8e-9d3a-7c5b2e8a1f10`.

## Design rules

- **`org_id` lives on ROOT tables only** — projects, companies, and org-owned
  catalogs/config. Child tables (schedule_items, decisions, po_line_items, …)
  resolve their org through their parent; never stamp them.
- **Bridge defaults**: every stamped column is `NOT NULL DEFAULT <hines>` so
  existing insert paths keep working while there is one org. Each later stage
  that makes a module's inserts org-aware **drops the default for its tables**.
  All defaults gone = the codebase is genuinely multi-tenant.
- **Membership** is `organization_members (org_id, profile_id, member_role
  owner|admin|member)`. The app-level `profiles.role` (staff/client/trade)
  stays and keeps meaning "role within their org" — a profile's org comes from
  membership, not from a column on profiles.
- **Helpers** (0099, security definer): `is_org_member(org uuid)`,
  `current_org_ids()`. All future org-scoped RLS builds on these.
- **RLS strategy**: existing policies gate by role (`is_staff()`, membership,
  trade visibility). Org scoping is a SECOND condition layered on top, e.g.
  staff read of projects becomes `is_staff() AND is_org_member(org_id)`;
  child tables scope via `exists (select 1 from projects p where p.id =
  project_id and is_org_member(p.org_id))`. Clients/trades are already scoped
  by project/company membership — org scoping is belt-and-suspenders there.

## Stage B1 — Foundation (DONE, migration 0099)

- `organizations`, `organization_members` (+ read-only RLS for members;
  writes are service-role-only until B5).
- `org_id NOT NULL DEFAULT hines` + index on the 11 roots: projects,
  companies, roles, cost_codes, purchasing_templates, app_settings,
  rental_properties, qbo_connection, insurance_documents, feedback_requests,
  communications. (`insurance_documents` and `communications` are stamped
  despite having parent links because both can exist unparented:
  needs_review certs with no company; unfiled global comms rows.)
- `app_settings` gains `unique(org_id, key)` alongside the legacy
  `unique(key)`; the legacy one drops in B3 when settings reads become
  org-aware.
- Backfill: every profile → Hines org (brandon@hineshomes.com = owner).
- Zero app-code changes beyond regenerated types.

## Stage B2 — RLS org scoping, module by module

One PR per module so each is reviewable and testable in isolation. For each:
rewrite the module's policies to add the org condition, drop the bridge
default on its root tables, and update the module's server actions to stamp
`org_id` explicitly (from the acting user's membership via `current_org_ids()`
— sole-org users need no picker until someone belongs to two orgs).

Order (blast radius, smallest first):
1. **DONE (0100)** Catalogs: roles, cost_codes, purchasing_templates,
   rental_properties (+ rental_items via parent), feedback_requests. Policies
   org-scoped, bridge defaults dropped, inserts stamped via
   `lib/org.ts:getActiveOrgId` (feedback/roles/rentals/purchasing-templates
   actions; cost_codes has no insert path). Isolation test passed both ways.
2. Companies (+ everything keyed by company: company_trades, insurance_*).
3. Projects + all project children (the big one — schedule, decisions, logs,
   files, payments, budget, purchasing, history/trash).
4. app_settings (org-scoped settings reads/writes; drop legacy unique(key);
   `getTemplateTagConfig`, budget_editors, disclaimer, notification recipients
   all become per-org).
5. communications (stamp at insert in webhook/compose/matcher paths; hub
   queries filter by org).
- Also in this stage: `profiles` read policies (staff can currently read all
  profiles) become org-scoped via shared membership.

**Testing gate for every B2 PR**: a second throwaway org + test user in the
database; assert the test user sees zero Hines rows and vice versa. This is
the data-leak firewall and it is not optional.

The fixture exists (created alongside 0100): org `Isolation Test Org`
(`99999999-0000-4000-8000-000000000099`, slug `isolation-test`) with staff
user `isolation-test@buildfox.internal`
(`99999999-0000-4000-8000-000000000001`, empty password hash — cannot log
in, exists only for SQL impersonation). Run the gate after each module:

```sql
select set_config('request.jwt.claims',
  '{"sub":"99999999-0000-4000-8000-000000000001","role":"authenticated"}', false);
set role authenticated;
select count(*) from <each newly scoped table>;  -- must all be 0
-- then repeat impersonating a real Hines staff profile: counts must be full.
```

## Stage B3 — Org-scoped settings & branding

- `lib/brand.ts` reads from `organizations.settings` (name, logo path, colors,
  the residential/commercial sub-brand map) with the current Hines/MJV values
  seeded as org #1's settings. Logo upload into a `brand/` storage prefix.
- Workspace header (sidebar) shows the org's name; PDFs/emails/token pages
  render org branding. The Hines-specific utilities/PDF configs (CAW, Lumber
  One — TIN, addresses) move into org settings and hide for orgs that lack
  them.

## Stage B4 — Per-org integrations

Env-var singletons become per-org rows (new table `org_integrations`, one row
per org+kind, encrypted secrets via pgsodium or app-layer encryption with a
KMS key in Vercel env):
- **QBO**: `qbo_connection` already carries org_id; the OAuth connect flow
  keys state by org; webhook resolves org via realmId lookup.
- **Quo/OpenPhone**: per-org API key + numbers; inbound webhook resolves org
  by phone-number id.
- **Resend inbound**: per-org inbound addresses (`insurance+<org>@…`,
  `comms+<org>@…`) or per-org subdomains; ingest resolves org before
  matching companies.
- **Microsoft Graph**: per-org tenant credentials (optional; Resend fallback
  covers orgs without M365).
- **CRM / SpecMagician / dashboard**: Hines-only; become org #1 settings and
  simply absent for other orgs (all call sites already no-op when unset).
- Cron jobs iterate orgs (insurance reminders, digests) instead of assuming
  one.

## Stage B5 — Onboarding, org management, billing

- Org admin UI: members list, invites (org-scoped `client_invites`-style
  tokens for staff), role management (owner/admin), org profile/branding
  editor. Writes to organizations/organization_members get RLS policies here
  (owner/admin only) — until then they stay service-role-only.
- Provisioning: create-org flow seeds cost codes, the Template project,
  default settings.
- Billing: Stripe customer per org, subscription webhooks → `org_billing`
  table, plan gates enforced app-layer (same trust tier as financial_access).
- Marketing-site handoff: demo → manual org creation first; self-serve signup
  only after the above is boring.

## Stage B6 — Storage scoping + hardening

- Storage paths gain org prefixes for NEW objects; storage RLS policies get
  the org condition (existing Hines objects stay at legacy paths — policies
  accept both during transition).
- Sweep: per-org advisory-lock keys for numbering RPCs are already per-project
  (fine); `search_path`/definer-function audit; pen-test pass with two orgs;
  load sanity on org-scoped indexes.
- Drop any remaining bridge defaults; add a CI check that fails if a stamped
  table still has the Hines default.

## Out of scope (unchanged from product scope)

Per-tenant subdomains (single app.buildfox.ai + org context is the model;
wildcard DNS is available later if wanted), SOC2, data residency.

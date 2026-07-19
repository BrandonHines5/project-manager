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
2. **DONE (0101)** Companies (+ company_trades, insurance_documents,
   insurance_policies). Entirely DB-side: save_company_with_trades stamps
   org_id from the caller's membership and its update path is org-guarded;
   child tables scope via parent company. companies default dropped;
   **insurance_documents keeps its bridge default until B4** (admin-client
   ingest channels become org-aware with per-org integrations). Gate passed
   both ways including a write-path probe through the RPC.
3. **DONE (0102)** Projects + all project children (the big one — schedule,
   decisions, logs, files, payments, budget, purchasing, history/trash,
   client_invites, qbo_invoices). projects gate on `is_org_member(org_id)`;
   children resolve through the parent chain via SECURITY DEFINER helpers
   (`project_in_my_org` + one per parent chain: schedule_item / decision /
   daily_log / bid_package / bid_recipient / purchase_order / payment
   `_in_my_org`) — inline EXISTS subqueries are NOT usable here because two
   parent tables' trade policies read child tables back
   (schedule_items↔schedule_assignments, bid_packages↔bid_recipients) and
   Postgres rejects the policy recursion. projects bridge default dropped;
   `createProject`/`duplicateProject`/warranty `addCrmProject` stamp org_id
   (duplicate copies `source.org_id`). `utility_requests` turned out to be an
   unparented root B1 missed (nullable project_id, all live rows global) — it
   gained `org_id` + org-scoped policy here and KEEPS its bridge default until
   utilities become org-aware in B3/B4. History/trash/qbo_invoices rows whose
   bare-uuid project is deleted become invisible (orphans; accepted). Client
   and trade policies untouched (already row-scoped). Gate passed both ways
   plus write probes (own-org insert allowed, cross-org insert 42501,
   cross-org update touches 0 rows).
4. **DONE (0103)** app_settings. The legacy uniqueness was the PRIMARY KEY
   (key); 0103 promotes 0099's unique index to `primary key (org_id, key)`.
   Policies keep their shapes (clients read only `decision_disclaimer`;
   staff read/write the rest) with the org condition layered on. All six
   upsert sites (template_tag_groups, delay_reasons, budget_editors,
   qbo_push_defaults, invoice_payment_recipients, decision_disclaimer) stamp
   org_id and use `onConflict: "org_id,key"`; bridge default dropped.
   User-session READS need no code change — RLS guarantees at most one
   visible row per key. The one admin-client reader (QBO webhook
   `paymentRecipientIds`) filters by the connection row's org_id and scopes
   both the configured list and the financial_access fallback to that org's
   members. Gate passed: test org sees 0 rows and can write only its own
   org; Hines staff see all 6; a Hines client sees exactly
   decision_disclaimer.
5. **DONE (0104)** communications. comms_staff_all gains the org condition
   (client/trade reads were already row-scoped); hub + job feeds are
   user-session reads so RLS scopes them with zero code changes. All
   communications INSERTS run on the admin client (lib/comms/log.ts funnel),
   so stamping is explicit: `CommLogContext`/`CommLogRow` carry `org_id`
   (compose stamps the acting staffer's org, hub replies the thread row's,
   client compose the validated project's), and `logCommunication` resolves
   a missing org from project_id → projects.org_id then company_id →
   companies.org_id. clientComposeMessage's staff fan-out now notifies only
   the project's org members. Bridge default KEPT (insurance_documents
   precedent): Quo/Resend/Outlook inbound are env-singleton Hines channels
   until B4 — fully unattributed inbound rows land on the default, and B4
   drops it when the channels resolve org per-integration. B4 must also
   org-filter `recentProjectForCompany` + the email plus-tag project
   validation (both admin reads, today implicitly single-org). Gate passed
   both ways with write probes.
- **DONE (0105)** Also in this stage: `profiles` read policies become
  org-scoped via shared membership — helper `shares_org_with(profile)`
  (definer). `profiles_self_read`'s staff arm and `profiles_staff_all`
  require a shared org (self access untouched; clients/trades never had
  cross-profile read). Same treatment for the profile-keyed stragglers
  `notification_preferences` (staff policy) and `ai_plan_applications`
  (staff read via `applied_by`). Companion code: `inviteTeamMember` enrolls
  the new staffer in the acting staffer's org BEFORE the staff-session role
  promote (which the new policy would otherwise reject), and client invite
  acceptance enrolls the client in the invite project's org (post-0099
  clients otherwise fail every `is_org_member` gate, e.g. the disclaimer
  read). Zero membership orphans verified pre-migration. Ad-hoc dashboard
  user creation must add a membership row manually until B5. Gate passed:
  test-org staffer sees only itself; Hines staff see all-but-test-org;
  a client sees only self; cross-org profile writes touch 0 rows.

**Stage B2 is COMPLETE** — every module's RLS is org-scoped. Remaining
bridge defaults (dropped in B4 when integrations become per-org):
`insurance_documents`, `communications`, `utility_requests`, `app_settings`
has none (0103), plus none on catalogs/companies/projects.

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

- **DONE (0106, part 1 — brand read path)**: `organizations.settings.brands`
  holds `{ default, commercial? }` Brand objects; `parseBrandConfig`
  (lib/brand.ts) validates with a neutral app-branded fallback carrying the
  org's NAME (never another org's logos), and `lib/org-brand.ts:
  getBrandConfig(client, orgId)` resolves it server-side (session client in
  layouts/pages, admin client on token pages). `brandForProjectType(s)` take
  an optional config — without one they keep the historical static Hines/MJV
  rule (login page, fallbacks). Converted: app shell layout (workspace brand
  = org's default; client all-commercial rule per org), project layout
  header, Pricing page/PDF, PO + bid token pages (incl. link-preview
  metadata), PO release/comment emails. Org #1 seeded with the exact
  historical values — zero visible change.
- **DONE (0107, part 2 — utility configs)**: the Initiate Utilities module's
  builder identity, provider intake emails, CAW payment URL, and regional
  lookup maps (ZIP by subdivision/city, county by city, per-subdivision
  delivery notes) live in `organizations.settings.utilities`, parsed by
  `lib/utilities/org-config.ts` (`getUtilityConfig(client, orgId)` — null =
  org lacks the module: page renders not-configured, actions refuse with a
  typed error). Secrets/env-overridable values (builder TIN, both submission
  emails, payment URL) keep their env fallbacks — the seed leaves them
  unset, so env continues to win until a B5 settings editor. Product
  constants (form enums, CAW_FIXED/CAW_DEFAULTS, meter threshold) stay in
  code. Org #1 seeded with the exact historical literals — zero behavior
  change for Hines.
- Remaining in B3: per-org logo upload into a `brand/` storage prefix (lands
  with the org-settings editor in B5).

## Stage B4 — Per-org integrations

**Groundwork landed**: insurance ingest is org-aware on every channel — the
sub upload route stamps the token company's org, staff manual upload stamps
the acting staffer's, a company match adopts the company's org onto the
document, and `matchCompany` scopes all directory/history queries to that
org. The inbound-email webhook resolves its org from the recipient plus-tag
too (part 2, details in the Resend bullet below), which is what let
`insurance_documents`' bridge default drop in 0113. The reminders cron is
inherently per-company (each email carries that company's own token), so
its only org coupling is the env-singleton kill switch + sender, handled
with the rest below.

Env-var singletons become per-org rows (new table `org_integrations`, one row
per org+kind). **Secrets decision (Brandon, 2026-07-19): app-layer AES-256-GCM
envelope encryption** with a master key in the Vercel env
(`INTEGRATION_SECRETS_KEY`, 32 random bytes) — not pgsodium/Vault. Secrets are
encrypted before insert and unreadable via SQL alone; rotation is a re-encrypt
sweep.

**DONE (0112, part 1 — storage foundation)**: `org_integrations` (PK
org+provider; `config` jsonb non-secret, `secrets` jsonb = envelope only,
`enabled` flag) with RLS enabled and NO policies — service-role-only, same
accepted pattern as the qbo tables. `lib/crypto/secrets.ts` implements the
envelope: AES-256-GCM under base64-32-byte `INTEGRATION_SECRETS_KEY`,
versioned `kid` (sha256 prefix of the key) with
`INTEGRATION_SECRETS_KEY_PREVIOUS` accepted during rotation sweeps, and
`${orgId}/${provider}` as AAD so an envelope can't be replayed onto another
row; everything fails closed (missing key / unknown kid / tamper / wrong
AAD all throw — verified by round-trip tests of all six properties).
`lib/integrations/org.ts` is the admin-client accessor
(`getOrgIntegration` decrypts or throws; `upsertOrgIntegration` seals with
undefined=keep / null=clear / object=replace semantics). Provider wiring
moves over one integration at a time (below) once
`INTEGRATION_SECRETS_KEY` is set in Vercel (asked Brandon 2026-07-19; the
PowerShell keygen one-liner is in the session log). Per-integration wiring:
- **QBO**: **DONE (part 3)** — one Intuit app serves the platform (client
  id/secret + webhook verifier stay env), but connections are per-org:
  `getQboConnection(orgId)` / `getQboConnectionByRealm(realmId)`, every
  client helper threads orgId (`qboGet/Query/Post(orgId, …)`), staff
  actions + the settings page resolve the active org, the OAuth callback
  stamps the connecting staffer's org and REFUSES a realm already owned by
  a different org (`realm_other_org`), and the webhook groups events by
  realm → connection row → org (invoice project lookups scope to that org
  since customer ids are only unique within a realm). 0114 dropped the
  qbo_connection bridge default (org-less inserts now 23502) and enforces
  EXACTLY one connection per org (unique index; the save replaces the
  org's prior row on a company switch, and PO pushes derive their org from
  the OWNING project, not the caller's active org).
- **Quo/OpenPhone**: **DONE (part 4)** — the API key + shared from-number
  move from env singletons into `org_integrations` provider `quo`
  (`secrets.apiKey` via the encrypted envelope — first real use of
  `INTEGRATION_SECRETS_KEY`; `config.sharedFromNumber`). `lib/quo.ts`
  `resolveQuoConfig(orgId)` reads them, with env `QUO_API_KEY` /
  `QUO_FROM_NUMBER` as the fallback for the LEGACY org ONLY — a non-legacy
  org with no row (or a decrypt failure) reads as "not connected", never
  borrows Hines' key. `sendQuoSms` resolves org from `opts.orgId` →
  `log.org_id` → the sender's membership (no call-site changes); the Team
  picker (`listQuoPhoneNumbers(orgId)`) resolves the active org's key. The
  inbound webhook stamps `communications.org_id` when it can (line owner's
  org → matched project → matched company). A non-legacy org enters its own
  Quo API key + shared number in the Integrations section of
  `/settings/organization` (**part 5**): `saveQuoIntegration` (owner/admin
  app-layer gate, since `org_integrations` is service-role-only) seals the
  key through `upsertOrgIntegration`, and the key is write-only — the page
  passes only a boolean "connected" + the non-secret number, never the key
  value; a decrypt failure surfaces as a "Connection error" badge, not a
  crash. Two things stay env/shared and keep `communications`' bridge
  default alive: `QUO_WEBHOOK_SECRET` (one endpoint, one OpenPhone
  workspace today — per-org inbound needs per-org webhook secrets/endpoints)
  and any fully-unattributed inbound row (shared line + unknown number has
  no org signal).
- **Resend inbound**: **DONE for insurance (part 2)** — the recipient
  plus-tag IS the org slug (`insurance+{org-slug}@domain`, zero per-org
  address config): the webhook resolves the org before ingest, untagged
  legacy mail files to org #1 via `lib/org.ts:LEGACY_ORG_ID`, an unknown
  tag warns + falls back rather than dropping a certificate, and the
  inbox-match check strips plus-tags on both sides. With all three ingest
  paths stamping explicitly, 0113 dropped the `insurance_documents` bridge
  default (and `utility_requests`' too — saveUtilityDrafts stamps the
  acting staffer's org). Probes: org-less inserts now fail (23502 / 42501
  via the RLS null-org check) and stamped inserts work. Comms inbound
  email gets the same treatment when comms goes per-org.
- **Resend outbound (email)**: **DONE (part 6, 0-migration)** — the API key
  + verified From address move from env singletons into `org_integrations`
  provider `resend` (`secrets.apiKey`, `config.fromEmail`/`fromName`).
  `lib/email.ts:resolveResendConfig(orgId)` reads them, env `RESEND_API_KEY`
  / `RESEND_FROM_EMAIL` as the fallback for the LEGACY org ONLY — a
  non-legacy org with no row (or a decrypt failure) reads as "not
  connected", and the Resend transport NO-OPS rather than sending a client
  email out of Hines' address. `sendEmail` resolves org from `opts.orgId` →
  `log.org_id` → the staffer's membership → the attributed project → company
  (no call-site changes; the shared `resolveOrgForProfile` moved to
  `lib/integrations/org.ts` and both senders use it). A non-legacy org
  enters its own Resend key + From address + optional From name in the
  Integrations section of `/settings/organization` (`saveResendIntegration`,
  owner/admin app-layer gate, key write-only, decrypt failure → "Connection
  error"). Env Resend keeps `communications`' bridge alive for fully-
  unattributed inbound only.
- **Microsoft Graph**: **DONE (part 6)** — Graph is Hines' Microsoft-365
  tenant (a single-tenant app), so it serves the LEGACY org only. A
  staffer's OWN mailbox stays their identity for any org, but the shared
  `MS_SYSTEM_MAILBOX` is gated behind `canUseSharedInfra` (legacy/bridge
  only): a non-legacy cron/system send skips Graph entirely and goes out
  through that org's Resend. Other orgs don't need M365 — their outbound is
  Resend end to end.
- **CRM / SpecMagician / dashboard**: Hines-only; become org #1 settings and
  simply absent for other orgs (all call sites already no-op when unset).
- Cron jobs iterate orgs (insurance reminders, digests) instead of assuming
  one.

## Stage B5 — Onboarding, org management, billing

- **DONE (0108, part 1 — active-org + admin foundation)**:
  `profiles.active_org_id` records which org a multi-org user is working in;
  `getActiveOrgId(supabase, profileId?)` honors it when it names one of the
  caller's own memberships and falls back to the earliest membership (the
  pre-B5 behavior for every single-org user). A forged selection is inert —
  the DB allows the self-update but resolution validates membership. Avatar-
  menu switcher renders only for 2+ memberships (`setActiveOrg` action →
  router.refresh, everything follows the active org). `org_admin(uuid)`
  helper + `orgs_admin_update` policy open organizations updates (name /
  settings) to owner/admin members — the first org-admin write surface.
- **DONE (0109, part 2 — org settings editor)**: `/settings/organization`
  (avatar-menu "Organization" link, rendered only for owner/admin members of
  the active org — layout reads `member_role` off `getOrgMemberships`). Edits
  org name + the default/commercial brand names, with logo + square-icon
  uploads per sub-brand. Uploads go browser → PUBLIC `brand-assets` bucket
  under `{org_id}/…` (public because brand marks render sessionless — token-
  page og:image, email headers — and signed URLs would rot stored configs;
  the `brand_assets_admin_all` storage policy restricts writes to owner/admin
  members of the prefix org). `saveOrgSettings` (app/actions/org.ts) runs on
  the session client so `orgs_admin_update` is the real gate (0 rows → clean
  error), accepts only storage PATHS (re-checks the org prefix, derives the
  public URL server-side — config can never point at another org's assets),
  keeps untouched slots' raw stored values + `key` verbatim (org #1's
  hines/mjv keys and seeded asset paths survive name-only edits), drops
  cleared slots so `parseBrandConfig` falls back to neutral, and preserves
  sibling settings blocks (utilities). Gate probed both ways: test-org owner
  ↔ Hines on organizations updates (0 rows cross-org) and storage.objects
  inserts (42501 cross-prefix, allowed own-prefix).
- **DONE (0110, part 3 — member management)**: organization_members writes
  open to org admins through two SECURITY DEFINER RPCs —
  `set_org_member_role(org, profile, role)` and
  `remove_org_member(org, profile)` — with the guards RLS can't express:
  owners manage everyone; admins manage NON-owners only (never grant/revoke
  owner, never touch an owner row); the last owner can't be demoted or
  removed (per-org advisory lock slot 5 makes the owner-count check atomic);
  removal nulls the target's matching `profiles.active_org_id`. The RPCs
  only manage EXISTING rows — enrollment stays with inviteTeamMember /
  client-invite acceptance (admin client), and cross-org email invites are a
  later slice. UI: a Members roster on `/settings/organization` (role select
  + two-tap remove; controls mirror the matrix, DB enforces it). Guard
  matrix probed via SQL impersonation: cross-org caller rejected, member
  caller rejected, admin blocked from owner rows/grants, last-owner demote
  and removal blocked, admin member↔admin + non-owner removal allowed.
- Org admin UI (remaining): invites (org-scoped `client_invites`-style
  tokens for staff joining an org directly).
- **DONE (0111, part 4 — provisioning)**: `create_organization(name, slug,
  owner, seed_from = org #1)` stands up a new org atomically — organizations
  row, owner enrollment, and catalog seeding (ACTIVE cost codes + all roles
  copied from the seed org; pass null to skip). Branding needs no seed
  (parseBrandConfig's org-name fallback) and purchasing_templates /
  app_settings are deliberately NOT copied (builder-specific content).
  Execution is SERVICE-ROLE-ONLY (manual org creation first per this plan —
  no app surface until self-serve/billing). 0111 also fixed two leftover
  single-tenant uniqueness rules that made catalogs collide across orgs:
  `cost_codes.code` global unique → `(org_id, code)`, and roles'
  `uq_roles_name_lower` → `uq_roles_org_name_lower (org_id, lower(trim(name)))`.
  Verified: provisioned a throwaway org (86/86 active codes, 51/51 roles,
  1 owner), authenticated caller gets 42501, cleanup left zero residue.
  Template-project cloning into a new org stays manual (duplicateProject
  after the fact) until a real second builder needs it.
- **DONE (0-migration, part 5 — provisioning UI)**: `/settings/provision-org`
  turns org creation from a manual SQL step into a single operator action.
  Gated to the OWNER of the legacy (Hines) org — the platform operator today
  (`platformAdmin` in the app layout gates the avatar-menu link;
  `provisionOrganization` in `app/actions/provisioning.ts` re-checks it
  server-side). It wraps `create_organization` with the one thing the RPC
  can't do — bootstrap the owner's login: create the owner auth user (temp
  password, returned once to share), promote that profile to staff via the
  admin client (service_role is exempt from `prevent_role_escalation`, and the
  caller doesn't yet share an org with the brand-new user so a session update
  would be RLS-blocked), run the RPC (always seeds from Hines — the NULL-no-
  seed path isn't typed in the generated RPC args, so the UI doesn't expose
  it), then set the owner's `active_org_id`. Any failure after createUser
  rolls the auth user back (cascades the profile); a taken email or slug
  surfaces a friendly error. Still NOT built below: self-serve signup +
  billing.
- Billing: Stripe customer per org, subscription webhooks → `org_billing`
  table, plan gates enforced app-layer (same trust tier as financial_access).
- Marketing-site handoff: demo → manual org creation first; self-serve signup
  only after the above is boring.

## Stage B6 — Storage scoping + hardening

- **DONE (0115, search_path)**: the definer/function `search_path` audit —
  pinned a fixed search_path on the last three
  `function_search_path_mutable` advisor WARNs. The two media-tag functions
  (`validate_media_tags`, `tags_before_write` from 0030) touch no relations,
  so `set search_path to 'public'` is enough. `upsert_org_integration`
  (0112) WRITES to a relation, so it gets the stricter form —
  `set search_path = public, pg_temp` (pg_temp explicitly LAST, since a bare
  `public` leaves it implicitly first and a role could shadow the table with
  a temp object) plus a schema-qualified `public.org_integrations` target.
  Zero behavior change; both the media-tag validation and the upsert were
  re-probed after. Security advisors now show only the accepted classes
  (definer-executable WARNs, `rls_enabled_no_policy` INFO on the
  service-role-only tables, leaked-password protection).
- Storage paths gain org prefixes for NEW objects; storage RLS policies get
  the org condition (existing Hines objects stay at legacy paths — policies
  accept both during transition).
- Sweep: per-org advisory-lock keys for numbering RPCs are already per-project
  (fine); pen-test pass with two orgs; load sanity on org-scoped indexes.
- **CI bridge-default guard: DONE** — `scripts/check-bridge-defaults.mjs`
  (run by `.github/workflows/bridge-default-guard.yml` on any migration
  change) replays the `org_id` DEFAULT set/drop history across the numbered
  migrations and fails if any ROOT table still carries the Hines bridge
  default outside the intentional allowlist. Pure static analysis — no DB or
  secrets. The allowlist (`communications` today) fails on staleness too, so
  it can't rot once the last default is dropped.
- Drop any remaining bridge defaults. **Remaining default**: only
  `communications`, held by the shared Quo webhook secret (one OpenPhone
  workspace/endpoint today) + genuinely-unattributable inbound (shared line,
  unknown number). Dropping it needs per-org OpenPhone workspaces
  (per-org webhook secrets/endpoints) — infrastructure, not a code change.

## Multi-tenant status (Path B)

**Substantively complete.** Every root table is org-scoped with RLS
enforcement (B2), branding + utilities are org-driven (B3), all live
integrations — insurance ingest, QBO connections, Quo, and outbound email
(Resend) — are per-org with an org-admin integrations editor and app-layer
AES-256-GCM secret storage (B4), and org management (active-org switcher,
settings/brand editor,
member-management RPCs, provisioning RPC) is shipped (B5). Three of four
0099 bridge defaults are dropped; the last (`communications`) is blocked on
per-org phone infrastructure, not code. The testing gate — a second
throwaway org sees zero Hines rows — has passed at every stage.

## Stage S — Self-serve trial + billing (SaaS go-to-market)

Turns the operator-provisioned multi-tenant base into a self-serve product: a
sales-site visitor signs up for a 7-day trial, hits a paywall when it lapses,
and subscribes to keep their data. Sandbox orgs are a strict subset — every
existing/provisioned org is `active_subscriber` and never participates.

- **S1 — sandbox lifecycle foundation: DONE (0116)**. `organizations.status`
  (`sandbox_active | sandbox_expired | active_subscriber`, default
  `active_subscriber`) + `sandbox_expires_at`; `org_writable(uuid)` predicate;
  `lib/sandbox.ts:resolveOrgLifecycle` lazy-flips an elapsed trial on read
  (CAS, fails open) and the app layout renders the full-screen
  `SandboxPaywall`. Inert until S2 mints the first sandbox org; verified the
  flip + `org_writable` end to end against a throwaway org, and every existing
  org stayed `active_subscriber`.
- **S1b — mutation block: PARTIAL (app-layer, core create/save surface)**.
  `lib/sandbox.ts:assertActiveOrgWritable` throws `TrialExpiredError` when the
  CALLER's active org is a lapsed sandbox (fail-CLOSED: it distinguishes a
  genuine "no org" — `NoActiveOrgError`, allow — from an operational error,
  which aborts the write, and reads status strictly rather than via the
  fail-open `resolveOrgLifecycle`; it also computes effective expiry so a
  just-lapsed trial is caught before the layout's lazy flip). Because it checks
  the *caller's own* org (not a target row's), one line gates every write
  **within a guarded action**, and it can NEVER freeze a non-trial org (an
  `active_subscriber` always resolves writable). **Coverage is only the core
  create/save actions so far** (createProject/duplicateProject, saveDecision,
  saveScheduleItem, saveDailyLog, saveBidPackage, savePurchaseOrder,
  saveCompany, saveBudgetLine) — the many other update/delete/comment actions
  are NOT yet guarded and rely on S1's inert-shell paywall (the primary block).
  Chose the app-layer guard over RLS because the org-scoped write policies are
  all `FOR ALL` with a shared read/write predicate, so an RLS block that spares
  reads is a ~50-policy sweep whose typo could freeze Hines' production writes.
  Extending the one-line guard to the remaining mutations (or an additive RLS
  restrictive-policy pass) is the follow-up — moot until a sandbox org can
  actually expire (S2 + 7 days).
- **S2 — self-serve trial signup**. A PUBLIC endpoint the (separate) sales
  site POSTs to; mints a sandbox org + owner (provisioning internals,
  `sandbox_active` + `now()+7d`). Public org creation is abuse-prone —
  mandatory email verification + rate limiting + CAPTCHA.
- **S3 — Stripe billing**. Customer per org, Checkout wired to the paywall's
  "Subscribe now", webhook flips `sandbox_expired → active_subscriber` (+
  clears `sandbox_expires_at`); handle cancellation/downgrade. Its own
  multi-PR slice (subscriptions, webhooks, customer portal, plan gating).
- **S4 — grace hard-delete cron**. Daily `/api/cron/sandbox-cleanup`
  (`CRON_SECRET`) hard-deletes sandbox orgs past `sandbox_expires_at + 30 days`
  — a 30-day grace measured from the trial's end (`sandbox_expires_at` is
  already 7 days past signup, so don't re-add the trial). Sandbox-only,
  logged, kill-switched OFF until S1–S3 are proven — an irreversible tenant
  wipe ships last.

## Out of scope (unchanged from product scope)

Per-tenant subdomains (single app.buildfox.ai + org context is the model;
wildcard DNS is available later if wanted), SOC2, data residency.

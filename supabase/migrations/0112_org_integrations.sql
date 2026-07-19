-- 0112: Stage B4 (part 1) — org_integrations foundation.
--
-- Env-var integration singletons (QBO, Quo, Resend, Microsoft Graph, the
-- Hines-only CRM/SpecMagician/dashboard hooks) become per-org rows here,
-- one row per org+provider. This migration is the storage foundation only —
-- provider wiring moves over one integration at a time.
--
-- `config` holds non-secret settings (from-numbers, account/realm ids,
-- inbound-address slugs, feature flags). `secrets` holds ONLY the
-- AES-256-GCM envelope produced by lib/crypto/secrets.ts
-- ({v, kid, iv, ct, tag} — Brandon's 2026-07-19 decision: app-layer
-- envelope encryption with the INTEGRATION_SECRETS_KEY master key in the
-- Vercel env, not pgsodium/Vault). Plaintext secrets must NEVER be written
-- to this table; SQL access alone cannot read them.
--
-- RLS is enabled with NO policies on purpose (same accepted pattern as
-- qbo_connection/qbo_po_sync): the table is service-role-only. Staff/admin
-- UI reads go through server actions that use the admin client and check
-- org membership at the app layer — authenticated sessions can never touch
-- secret material, encrypted or not.

create table org_integrations (
  org_id     uuid not null references organizations(id) on delete cascade,
  provider   text not null check (provider ~ '^[a-z][a-z0-9_]{1,40}$'),
  enabled    boolean not null default true,
  config     jsonb not null default '{}'::jsonb,
  secrets    jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, provider)
);

comment on table org_integrations is
  'Per-org integration settings (B4). config = non-secret; secrets = AES-256-GCM envelope from lib/crypto/secrets.ts, never plaintext. Service-role-only: RLS enabled with no policies.';

alter table org_integrations enable row level security;

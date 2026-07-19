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

create table if not exists org_integrations (
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

-- Atomic partial upsert — one statement, so two concurrent writers (an
-- admin edit racing a webhook-driven token refresh once provider wiring
-- lands) can't lose each other's fields the way a read-then-write would.
-- NULL params mean "leave as is" for enabled/config; secrets uses the
-- explicit p_touch_secrets flag because NULL is a meaningful value there
-- (clear the stored envelope). Encryption stays app-side — p_secrets is
-- already an envelope (or null) when it arrives here. SECURITY INVOKER on
-- purpose: only service_role can execute, and it already owns the table.
create or replace function public.upsert_org_integration(
  p_org uuid,
  p_provider text,
  p_enabled boolean default null,
  p_config jsonb default null,
  p_secrets jsonb default null,
  p_touch_secrets boolean default false
) returns void
language sql
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

revoke all on function upsert_org_integration(uuid, text, boolean, jsonb, jsonb, boolean) from public;
revoke execute on function upsert_org_integration(uuid, text, boolean, jsonb, jsonb, boolean) from anon;
revoke execute on function upsert_org_integration(uuid, text, boolean, jsonb, jsonb, boolean) from authenticated;
grant execute on function upsert_org_integration(uuid, text, boolean, jsonb, jsonb, boolean) to service_role;

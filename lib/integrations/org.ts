import "server-only"
import type { SupabaseClient } from "@supabase/supabase-js"
import type { Database, Json } from "@/lib/db/types"
import {
  decryptSecrets,
  encryptSecrets,
  isSecretEnvelope,
} from "@/lib/crypto/secrets"

// Per-org integration rows (B4, 0112). The table is service-role-only —
// every caller here passes the ADMIN client and is responsible for its own
// org authorization (webhooks resolve the org from the event; server
// actions check the acting user's membership). Secrets are sealed with the
// row's own org+provider as AAD, so an envelope copied onto another row
// refuses to decrypt.

export type OrgIntegration = {
  org_id: string
  provider: string
  enabled: boolean
  config: Record<string, unknown>
  /** Decrypted secret material; null when the row stores none. */
  secrets: Record<string, unknown> | null
}

function envelopeAad(orgId: string, provider: string): string {
  return `${orgId}/${provider}`
}

function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {}
}

/**
 * One org's integration row, secrets decrypted — null when the org has no
 * row for the provider. Decryption failures THROW (fails closed): a
 * misconfigured master key must surface as an error, never as "integration
 * not connected".
 */
export async function getOrgIntegration(
  admin: SupabaseClient<Database>,
  orgId: string,
  provider: string
): Promise<OrgIntegration | null> {
  const { data, error } = await admin
    .from("org_integrations")
    .select("org_id, provider, enabled, config, secrets")
    .eq("org_id", orgId)
    .eq("provider", provider)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!data) return null
  return {
    org_id: data.org_id,
    provider: data.provider,
    enabled: data.enabled,
    config: asObject(data.config),
    secrets:
      data.secrets == null
        ? null
        : decryptSecrets(data.secrets, envelopeAad(orgId, provider)),
  }
}

/**
 * Create/update an org's integration row. `secrets` semantics: undefined =
 * leave stored secrets untouched, null = clear them, object = seal and
 * replace. Config replaces wholesale when provided (callers read-modify-
 * write; these are small settings blobs).
 */
export async function upsertOrgIntegration(
  admin: SupabaseClient<Database>,
  orgId: string,
  provider: string,
  input: {
    enabled?: boolean
    config?: Record<string, unknown>
    secrets?: Record<string, unknown> | null
  }
): Promise<void> {
  const { data: existing, error: readErr } = await admin
    .from("org_integrations")
    .select("enabled, config, secrets")
    .eq("org_id", orgId)
    .eq("provider", provider)
    .maybeSingle()
  if (readErr) throw new Error(readErr.message)

  // Guard against clobbering a real envelope with garbage: whatever we
  // carry forward must still BE an envelope (or null).
  const carriedSecrets =
    existing?.secrets != null && isSecretEnvelope(existing.secrets)
      ? existing.secrets
      : null

  const nextSecrets =
    input.secrets === undefined
      ? carriedSecrets
      : input.secrets === null
        ? null
        : encryptSecrets(input.secrets, envelopeAad(orgId, provider))

  const { error } = await admin.from("org_integrations").upsert(
    {
      org_id: orgId,
      provider,
      enabled: input.enabled ?? existing?.enabled ?? true,
      config: (input.config ?? asObject(existing?.config)) as Json,
      secrets: nextSecrets as Json,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "org_id,provider" }
  )
  if (error) throw new Error(error.message)
}

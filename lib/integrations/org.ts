import "server-only"
import type { SupabaseClient } from "@supabase/supabase-js"
import type { Database, Json } from "@/lib/db/types"
import { decryptSecrets, encryptSecrets } from "@/lib/crypto/secrets"
import { createSupabaseAdminClient } from "@/lib/supabase/admin"

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
 * Every enabled org's decrypted secrets for one provider — the inbound Quo
 * webhook's multi-workspace verification source (it must try each tenant's
 * stored signing secret against an event before knowing whose it is). Unlike
 * getOrgIntegration, a row whose envelope won't decrypt is SKIPPED with a
 * warning instead of throwing: one tenant's corrupt envelope must not take
 * down every other tenant's webhook, and a skipped secret can only make
 * verification fail (the event is dropped), never misroute it to another org.
 *
 * Scale note: this decrypts every enabled row for the provider on each call
 * (OpenPhone signatures carry no workspace identifier, so verification must
 * try each candidate). Fine while bring-your-own OpenPhone orgs number in the
 * dozens; if that grows hot, add a short-lived in-memory cache of decrypted
 * secrets keyed by row updated_at.
 */
export async function listOrgIntegrationSecrets(
  admin: SupabaseClient<Database>,
  provider: string
): Promise<{ org_id: string; secrets: Record<string, unknown> }[]> {
  const { data, error } = await admin
    .from("org_integrations")
    .select("org_id, secrets")
    .eq("provider", provider)
    .eq("enabled", true)
    .not("secrets", "is", null)
  if (error) throw new Error(error.message)
  const out: { org_id: string; secrets: Record<string, unknown> }[] = []
  for (const row of data ?? []) {
    try {
      out.push({
        org_id: row.org_id,
        secrets: decryptSecrets(row.secrets, envelopeAad(row.org_id, provider)),
      })
    } catch (e) {
      console.warn(
        `[integrations] skipping undecryptable ${provider} secrets for org ${row.org_id}:`,
        e instanceof Error ? e.message : e
      )
    }
  }
  return out
}

/**
 * Create/update an org's integration row. `secrets` semantics: undefined =
 * leave stored secrets untouched, null = clear them, object = seal and
 * replace. Omitted `enabled`/`config` keep their stored values. The write
 * is a single atomic statement (0112 `upsert_org_integration`) — untouched
 * fields carry forward in the database itself, so concurrent writers can't
 * lose each other's changes and a stored envelope this call isn't touching
 * is never read, re-validated, or rewritten.
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
  const touchSecrets = input.secrets !== undefined
  const envelope =
    input.secrets == null
      ? null
      : encryptSecrets(input.secrets, envelopeAad(orgId, provider))
  const { error } = await admin.rpc("upsert_org_integration", {
    p_org: orgId,
    p_provider: provider,
    p_enabled: input.enabled ?? undefined,
    p_config: (input.config as Json) ?? undefined,
    p_secrets: (envelope as Json) ?? undefined,
    p_touch_secrets: touchSecrets,
  })
  if (error) throw new Error(error.message)
}

/**
 * The org a staffer belongs to, resolved admin-side (send paths — SMS/email —
 * have no session). Earliest membership; one org per user today. `failed`
 * distinguishes a query ERROR (the caller must fail closed — a transient
 * hiccup must never let one org borrow another's integration credentials)
 * from a genuine no-membership (`orgId` null, `failed` false — the
 * single-tenant bridge). Shared by the per-org Quo and Resend senders.
 */
export async function resolveOrgForProfile(
  profileId: string | null | undefined
): Promise<{ orgId: string | null; failed: boolean }> {
  if (!profileId) return { orgId: null, failed: false }
  const admin = createSupabaseAdminClient()
  // No service-role client = the integration layer can't verify the org. Fail
  // closed (like a query error) so a missing key can't masquerade as an
  // unresolved org and let a non-legacy send borrow Hines' shared credentials.
  if (!admin) return { orgId: null, failed: true }
  const { data, error } = await admin
    .from("organization_members")
    .select("org_id")
    .eq("profile_id", profileId)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle()
  if (error) {
    console.warn("[integrations] profile → org lookup failed:", error.message)
    return { orgId: null, failed: true }
  }
  return { orgId: data?.org_id ?? null, failed: false }
}

"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"
import { requireSession } from "@/lib/auth"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { createSupabaseAdminClient } from "@/lib/supabase/admin"
import { getOrgIntegration, upsertOrgIntegration } from "@/lib/integrations/org"
import type { Json } from "@/lib/db/types"

/**
 * Switch the caller's active organization (B5). Validates the target against
 * their OWN organization_members rows — a non-membership is rejected, so
 * profiles.active_org_id can only ever point somewhere getActiveOrgId would
 * honor anyway. Self-update rides profiles_self_update RLS.
 */
export async function setActiveOrg(
  orgId: string
): Promise<{ ok: boolean; error?: string }> {
  const profile = await requireSession()
  const parsed = z.string().uuid().safeParse(orgId)
  if (!parsed.success) return { ok: false, error: "Invalid organization." }
  const supabase = await createSupabaseServerClient()

  const { data: membership, error: memErr } = await supabase
    .from("organization_members")
    .select("org_id")
    .eq("profile_id", profile.id)
    .eq("org_id", parsed.data)
    .maybeSingle()
  if (memErr) return { ok: false, error: memErr.message }
  if (!membership) {
    return { ok: false, error: "You aren't a member of that organization." }
  }

  const { error } = await supabase
    .from("profiles")
    .update({ active_org_id: parsed.data })
    .eq("id", profile.id)
  if (error) return { ok: false, error: error.message }

  // Every layout and page derives branding/data from the active org.
  revalidatePath("/", "layout")
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Org settings editor (B5 part 2)

const BrandInputSchema = z.object({
  name: z.string().trim().min(1, "Brand name is required").max(80),
  /**
   * Storage paths (brand-assets bucket) of freshly uploaded images — the
   * browser uploads under the caller's JWT (the brand_assets_admin_all
   * policy gates the prefix) and sends only the path; the server re-checks
   * the org prefix and derives the public URL itself, so the stored config
   * can never point at another org's assets or an arbitrary URL.
   */
  logoPath: z.string().max(300).nullish(),
  iconPath: z.string().max(300).nullish(),
  /** Reset the slot to the neutral app defaults (parseBrandConfig fills). */
  clearLogo: z.boolean().optional(),
  clearIcon: z.boolean().optional(),
})

const SaveOrgSettingsSchema = z.object({
  orgId: z.string().uuid(),
  name: z.string().trim().min(1, "Organization name is required").max(120),
  defaultBrand: BrandInputSchema,
  /** null = the org has no commercial sub-brand (drops any existing one). */
  commercialBrand: BrandInputSchema.nullable(),
})

export type BrandInput = z.infer<typeof BrandInputSchema>
export type SaveOrgSettingsInput = z.infer<typeof SaveOrgSettingsSchema>

function validAssetPath(path: string, orgId: string): boolean {
  return (
    path.startsWith(`${orgId}/`) &&
    !path.includes("..") &&
    /^[A-Za-z0-9/_.-]+$/.test(path)
  )
}

function asObject(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null
}

/**
 * The next stored brand object: uploaded assets replace, cleared slots drop
 * (parseBrandConfig falls back to the neutral defaults), untouched slots keep
 * the RAW stored strings verbatim — so org #1's seeded /brand/hines-*.svg
 * paths survive a name-only edit, and `key` never changes once set (BrandTile
 * gives "hines" special tile-fill rendering).
 */
function nextBrand(
  raw: Record<string, unknown> | null,
  input: BrandInput,
  fallbackKey: string,
  publicUrl: (path: string) => string
): Record<string, unknown> {
  const keep = (k: string): string | undefined => {
    const v = raw?.[k]
    return typeof v === "string" && v.trim() ? v : undefined
  }
  const out: Record<string, unknown> = {
    key: keep("key") ?? fallbackKey,
    name: input.name,
  }
  if (input.logoPath) {
    const url = publicUrl(input.logoPath)
    out.mark = url
    out.logo = url
  } else if (!input.clearLogo) {
    const mark = keep("mark")
    const logo = keep("logo")
    if (mark) out.mark = mark
    if (logo) out.logo = logo
  }
  if (input.iconPath) {
    out.icon = publicUrl(input.iconPath)
  } else if (!input.clearIcon) {
    const icon = keep("icon")
    if (icon) out.icon = icon
  }
  return out
}

/**
 * Save the org's name + client-facing brands (`organizations.settings.brands`,
 * the parseBrandConfig shape). Runs under the caller's session so the 0108
 * orgs_admin_update policy is the real gate — a non-admin's update matches
 * zero rows and returns a clean error. Other settings blocks (utilities, …)
 * are preserved untouched.
 */
export async function saveOrgSettings(
  input: SaveOrgSettingsInput
): Promise<{ ok: boolean; error?: string }> {
  await requireSession()
  const parsed = SaveOrgSettingsSchema.safeParse(input)
  if (!parsed.success) {
    return {
      ok: false,
      error:
        parsed.error.issues[0]?.message ?? "Invalid organization settings.",
    }
  }
  const { orgId, name, defaultBrand, commercialBrand } = parsed.data
  for (const brand of [defaultBrand, commercialBrand]) {
    for (const path of [brand?.logoPath, brand?.iconPath]) {
      if (path && !validAssetPath(path, orgId)) {
        return { ok: false, error: "Invalid logo upload path." }
      }
    }
  }

  const supabase = await createSupabaseServerClient()
  const { data: org, error: orgErr } = await supabase
    .from("organizations")
    .select("settings")
    .eq("id", orgId)
    .maybeSingle()
  if (orgErr) return { ok: false, error: orgErr.message }
  if (!org) return { ok: false, error: "Organization not found." }

  const publicUrl = (path: string): string =>
    supabase.storage.from("brand-assets").getPublicUrl(path).data.publicUrl

  const settings = { ...(asObject(org.settings) ?? {}) }
  const rawBrands = asObject(settings.brands)
  const brands: Record<string, unknown> = {
    default: nextBrand(
      asObject(rawBrands?.default),
      defaultBrand,
      "org",
      publicUrl
    ),
  }
  if (commercialBrand) {
    brands.commercial = nextBrand(
      asObject(rawBrands?.commercial),
      commercialBrand,
      "commercial",
      publicUrl
    )
  }
  settings.brands = brands

  const { data: updated, error } = await supabase
    .from("organizations")
    .update({ name, settings: settings as Json })
    .eq("id", orgId)
    .select("id")
  if (error) return { ok: false, error: error.message }
  if (!updated?.length) {
    return {
      ok: false,
      error: "Only organization owners and admins can edit these settings.",
    }
  }

  // Branding flows through every layout, PDF, and token page.
  revalidatePath("/", "layout")
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Org member management (B5 part 3)
//
// Both actions are thin wrappers over the 0110 SECURITY DEFINER RPCs — the
// permission matrix (owners manage everyone; admins manage non-owners only;
// last-owner protection) lives in the database, so a forged call gets the
// same rejection the UI would.

const MemberRoleSchema = z.enum(["owner", "admin", "member"])
export type OrgMemberRole = z.infer<typeof MemberRoleSchema>

export async function setOrgMemberRole(input: {
  orgId: string
  profileId: string
  role: OrgMemberRole
}): Promise<{ ok: boolean; error?: string }> {
  await requireSession()
  const parsed = z
    .object({
      orgId: z.string().uuid(),
      profileId: z.string().uuid(),
      role: MemberRoleSchema,
    })
    .safeParse(input)
  if (!parsed.success) return { ok: false, error: "Invalid member update." }
  const supabase = await createSupabaseServerClient()
  const { error } = await supabase.rpc("set_org_member_role", {
    p_org: parsed.data.orgId,
    p_profile: parsed.data.profileId,
    p_role: parsed.data.role,
  })
  if (error) return { ok: false, error: error.message }
  // Role changes move the target's Organization link + this page's controls.
  revalidatePath("/", "layout")
  return { ok: true }
}

export async function removeOrgMember(input: {
  orgId: string
  profileId: string
}): Promise<{ ok: boolean; error?: string }> {
  await requireSession()
  const parsed = z
    .object({ orgId: z.string().uuid(), profileId: z.string().uuid() })
    .safeParse(input)
  if (!parsed.success) return { ok: false, error: "Invalid member removal." }
  const supabase = await createSupabaseServerClient()
  const { error } = await supabase.rpc("remove_org_member", {
    p_org: parsed.data.orgId,
    p_profile: parsed.data.profileId,
  })
  if (error) return { ok: false, error: error.message }
  revalidatePath("/", "layout")
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Org integrations editor (B4 part 5)
//
// org_integrations is service-role-only (RLS enabled, no policies), so these
// actions gate authorization at the APP layer: the caller must be an
// owner/admin member of the target org — the same trust tier as the other
// admin-client writes in this codebase. Secrets are WRITE-ONLY: the API key
// is sealed by upsertOrgIntegration's envelope and never round-trips back to
// the client (the page passes only a boolean "connected" + the non-secret
// shared number).

const QuoIntegrationSchema = z.object({
  orgId: z.string().uuid(),
  // Blank/omitted keeps the stored key (so a shared-number-only edit doesn't
  // require re-typing the secret); a non-empty value seals + replaces it.
  apiKey: z.string().trim().max(300).optional(),
  // Empty string clears the shared number; config replaces wholesale.
  sharedFromNumber: z.string().trim().max(40).optional(),
  // The OpenPhone webhook's signing secret (bring-your-own workspaces) —
  // lets /api/inbound/quo verify that workspace's events so replies and
  // Quo-app texts/calls mirror into the feed. Same write-only semantics as
  // apiKey: blank/omitted keeps the stored one.
  webhookSecret: z.string().trim().max(300).optional(),
  // Turns the integration off and clears the stored key.
  disconnect: z.boolean().optional(),
})

async function requireOrgAdmin(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  orgId: string,
  profileId: string
): Promise<boolean> {
  const { data } = await supabase
    .from("organization_members")
    .select("member_role")
    .eq("org_id", orgId)
    .eq("profile_id", profileId)
    .maybeSingle()
  return data?.member_role === "owner" || data?.member_role === "admin"
}

/**
 * Save (or disconnect) the org's Quo/OpenPhone credentials. Owner/admin only
 * (app-layer gate; org_integrations has no RLS). The API key is sealed and
 * never returned to the browser.
 */
export async function saveQuoIntegration(
  input: z.infer<typeof QuoIntegrationSchema>
): Promise<{ ok: boolean; error?: string }> {
  const profile = await requireSession()
  const parsed = QuoIntegrationSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: "Invalid integration input." }
  const { orgId, apiKey, sharedFromNumber, webhookSecret, disconnect } = parsed.data

  const supabase = await createSupabaseServerClient()
  if (!(await requireOrgAdmin(supabase, orgId, profile.id))) {
    return {
      ok: false,
      error: "Only organization owners and admins can change integrations.",
    }
  }

  const admin = createSupabaseAdminClient()
  if (!admin) return { ok: false, error: "Server storage is not configured." }

  try {
    if (disconnect) {
      await upsertOrgIntegration(admin, orgId, "quo", {
        enabled: false,
        secrets: null,
        config: {},
      })
    } else {
      // Two write-only secrets share one sealed envelope, and an envelope
      // replaces wholesale — so supplying one field must not drop the other.
      // Merge the typed values over the stored secrets; an unreadable stored
      // envelope falls back to just the typed fields (typing a new value is
      // the documented reset path for a corrupt envelope). undefined = no
      // secret typed = leave the envelope untouched.
      let secrets: Record<string, unknown> | undefined
      if (apiKey || webhookSecret) {
        let existing: Record<string, unknown> = {}
        try {
          existing = (await getOrgIntegration(admin, orgId, "quo"))?.secrets ?? {}
        } catch {
          // Distinguish a CORRUPT envelope (replace with just the typed
          // fields — the documented reset) from a transient READ failure
          // (abort — overwriting on a hiccup would silently destroy the
          // sibling secret). The probe re-reads the row without decrypting.
          const probe = await admin
            .from("org_integrations")
            .select("org_id")
            .eq("org_id", orgId)
            .eq("provider", "quo")
            .maybeSingle()
          if (probe.error) {
            return {
              ok: false,
              error: "Couldn't read the stored integration — try again.",
            }
          }
          existing = {}
        }
        secrets = { ...existing }
        if (apiKey) secrets.apiKey = apiKey
        if (webhookSecret) secrets.webhookSecret = webhookSecret
      }
      await upsertOrgIntegration(admin, orgId, "quo", {
        enabled: true,
        config: { sharedFromNumber: sharedFromNumber || null },
        secrets,
      })
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Save failed." }
  }

  revalidatePath("/settings/organization")
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Per-org email (Resend) integration — the email analogue of saveQuoIntegration.
// Same app-layer owner/admin gate; the API key is WRITE-ONLY (the page passes a
// boolean "connected" + the non-secret From address, never the key).

const ResendIntegrationSchema = z.object({
  orgId: z.string().uuid(),
  // Blank/omitted keeps the stored key; a non-empty value seals + replaces it.
  apiKey: z.string().trim().max(300).optional(),
  // The verified From address the org sends from. Empty string clears it.
  fromEmail: z
    .union([z.literal(""), z.string().trim().email().max(200)])
    .optional(),
  // Optional default display name on the From line. Empty clears it.
  fromName: z.string().trim().max(120).optional(),
  // Turns the integration off and clears the stored key.
  disconnect: z.boolean().optional(),
})

/**
 * Save (or disconnect) the org's Resend email credentials. Owner/admin only
 * (app-layer gate; org_integrations has no RLS). The API key is sealed and
 * never returned to the browser. `fromEmail`/`fromName` are non-secret config.
 */
export async function saveResendIntegration(
  input: z.infer<typeof ResendIntegrationSchema>
): Promise<{ ok: boolean; error?: string }> {
  const profile = await requireSession()
  const parsed = ResendIntegrationSchema.safeParse(input)
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid integration input.",
    }
  }
  const { orgId, apiKey, fromEmail, fromName, disconnect } = parsed.data

  const supabase = await createSupabaseServerClient()
  if (!(await requireOrgAdmin(supabase, orgId, profile.id))) {
    return {
      ok: false,
      error: "Only organization owners and admins can change integrations.",
    }
  }

  const admin = createSupabaseAdminClient()
  if (!admin) return { ok: false, error: "Server storage is not configured." }

  try {
    if (disconnect) {
      await upsertOrgIntegration(admin, orgId, "resend", {
        enabled: false,
        secrets: null,
        config: {},
      })
    } else {
      await upsertOrgIntegration(admin, orgId, "resend", {
        enabled: true,
        config: {
          fromEmail: fromEmail || null,
          fromName: fromName || null,
        },
        // undefined = keep the stored key; a typed value seals + replaces.
        secrets: apiKey ? { apiKey } : undefined,
      })
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Save failed." }
  }

  revalidatePath("/settings/organization")
  return { ok: true }
}

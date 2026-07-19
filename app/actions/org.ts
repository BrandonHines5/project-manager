"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"
import { requireSession } from "@/lib/auth"
import { createSupabaseServerClient } from "@/lib/supabase/server"
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

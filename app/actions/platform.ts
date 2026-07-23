"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"
import { requireStaff } from "@/lib/auth"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { createSupabaseAdminClient } from "@/lib/supabase/admin"
import { isLegacyOrgOwner, LEGACY_ORG_ID } from "@/lib/org"
import { INTERNAL_PLAN, isFeatureKey } from "@/lib/features"

// Feature-access administration (0122) — PLATFORM-OPERATOR surface, the same
// trust tier as provisioning: every action re-checks that the caller is the
// legacy-org OWNER (the avatar-menu link is cosmetic; this check is the
// gate). Writes go through the ADMIN client because platform_plans has no
// write policies and the operator isn't a member of the orgs being assigned.

const FEATURES_PATH = "/settings/features"

/** Owner-of-legacy-org gate (the provisioning pattern). Returns the error
 *  result to hand back, or null when the caller is the platform operator. */
async function requirePlatformAdmin(): Promise<{ ok: false; error: string } | null> {
  const me = await requireStaff()
  const supabase = await createSupabaseServerClient()
  if (!(await isLegacyOrgOwner(supabase, me.id))) {
    return { ok: false, error: "Only the platform owner can manage feature access." }
  }
  return null
}

const PlanKeySchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,39}$/, "Invalid level key.")

const CreatePlanSchema = z.object({
  name: z.string().trim().min(1, "Name the level.").max(80),
})

/**
 * Creates a new access level with NO features enabled (the operator checks
 * boxes next). The key is slugged from the name and never changes after
 * creation, so org assignments and future Stripe price mappings stay stable
 * across renames.
 */
export async function createPlatformPlan(
  input: z.infer<typeof CreatePlanSchema>
): Promise<{ ok: true; key: string } | { ok: false; error: string }> {
  const denied = await requirePlatformAdmin()
  if (denied) return denied
  const parsed = CreatePlanSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." }
  }

  const key = parsed.data.name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
  if (!PlanKeySchema.safeParse(key).success) {
    return { ok: false, error: "Name must contain letters or numbers." }
  }
  if (key === INTERNAL_PLAN) {
    return { ok: false, error: `"${parsed.data.name}" is reserved.` }
  }

  const admin = createSupabaseAdminClient()
  if (!admin) return { ok: false, error: "Server storage is not configured." }

  // New levels sort after existing ones; ties are fine (name breaks them).
  const { data: last } = await admin
    .from("platform_plans")
    .select("position")
    .order("position", { ascending: false })
    .limit(1)
    .maybeSingle()
  const { error } = await admin.from("platform_plans").insert({
    key,
    name: parsed.data.name,
    features: [],
    position: (last?.position ?? 0) + 1,
  })
  if (error) {
    return {
      ok: false,
      error: error.code === "23505" ? "A level with that name already exists." : error.message,
    }
  }
  revalidatePath(FEATURES_PATH)
  return { ok: true, key }
}

const SavePlanSchema = z.object({
  key: PlanKeySchema,
  // Omitted = keep. Feature keys are validated against the code catalog —
  // unknown strings are dropped, so a stale client can't store junk.
  name: z.string().trim().min(1).max(80).optional(),
  features: z.array(z.string()).max(100).optional(),
})

/** Renames a level and/or replaces its feature list. 'internal' is locked. */
export async function savePlatformPlan(
  input: z.infer<typeof SavePlanSchema>
): Promise<{ ok: boolean; error?: string }> {
  const denied = await requirePlatformAdmin()
  if (denied) return denied
  const parsed = SavePlanSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: "Invalid input." }
  const { key, name, features } = parsed.data
  if (key === INTERNAL_PLAN) {
    return { ok: false, error: "The Internal level always has every feature." }
  }

  const admin = createSupabaseAdminClient()
  if (!admin) return { ok: false, error: "Server storage is not configured." }

  const update: {
    updated_at: string
    name?: string
    features?: string[]
  } = { updated_at: new Date().toISOString() }
  if (name !== undefined) update.name = name
  if (features !== undefined) update.features = features.filter(isFeatureKey)

  const { data, error } = await admin
    .from("platform_plans")
    .update(update)
    .eq("key", key)
    .select("key")
  if (error) return { ok: false, error: error.message }
  if (!data?.length) return { ok: false, error: "That level no longer exists." }
  revalidatePath(FEATURES_PATH)
  return { ok: true }
}

/**
 * Deletes an empty level. The FK from organizations.plan blocks deleting one
 * that still has organizations assigned (surfaced as a friendly error).
 */
export async function deletePlatformPlan(input: {
  key: string
}): Promise<{ ok: boolean; error?: string }> {
  const denied = await requirePlatformAdmin()
  if (denied) return denied
  const parsed = z.object({ key: PlanKeySchema }).safeParse(input)
  if (!parsed.success) return { ok: false, error: "Invalid input." }
  if (parsed.data.key === INTERNAL_PLAN) {
    return { ok: false, error: "The Internal level can't be deleted." }
  }

  const admin = createSupabaseAdminClient()
  if (!admin) return { ok: false, error: "Server storage is not configured." }

  const { error } = await admin
    .from("platform_plans")
    .delete()
    .eq("key", parsed.data.key)
  if (error) {
    return {
      ok: false,
      error:
        error.code === "23503"
          ? "Move its organizations to another level first."
          : error.message,
    }
  }
  revalidatePath(FEATURES_PATH)
  return { ok: true }
}

const AssignSchema = z.object({
  orgId: z.string().uuid(),
  plan: PlanKeySchema,
})

/**
 * Assigns an organization to an access level. The legacy (Hines) org is
 * locked to 'internal' — the operator's own workspace can never be
 * restricted, even by the operator.
 */
export async function setOrganizationPlan(
  input: z.infer<typeof AssignSchema>
): Promise<{ ok: boolean; error?: string }> {
  const denied = await requirePlatformAdmin()
  if (denied) return denied
  const parsed = AssignSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: "Invalid input." }
  const { orgId, plan } = parsed.data
  if (orgId === LEGACY_ORG_ID && plan !== INTERNAL_PLAN) {
    return { ok: false, error: "The platform organization stays on Internal." }
  }

  const admin = createSupabaseAdminClient()
  if (!admin) return { ok: false, error: "Server storage is not configured." }

  const { data, error } = await admin
    .from("organizations")
    .update({ plan })
    .eq("id", orgId)
    .select("id")
  if (error) {
    return {
      ok: false,
      error: error.code === "23503" ? "That level no longer exists." : error.message,
    }
  }
  if (!data?.length) return { ok: false, error: "Organization not found." }
  revalidatePath(FEATURES_PATH)
  return { ok: true }
}

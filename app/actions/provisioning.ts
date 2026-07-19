"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"
import { requireStaff } from "@/lib/auth"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { createSupabaseAdminClient } from "@/lib/supabase/admin"
import { isLegacyOrgOwner } from "@/lib/org"
import { provisionOrgCore } from "@/lib/provisioning/core"

// Org provisioning (B5 onboarding). Standing up a NEW builder org is the
// SaaS-operator action — distinct from the per-org admin surfaces — so it's
// gated to the OWNER of the legacy (Hines) org, the platform operator today.
// The heavy lifting (org row + owner enrollment + catalog seed) is the
// service-role-only `create_organization` RPC (0111); this action wraps it
// with the one thing it can't do — bootstrap the owner's login — so the whole
// flow is a single UI action instead of manual SQL.

const ProvisionOrgInput = z.object({
  orgName: z.string().trim().min(1, "Organization name is required.").max(120),
  // Mirror create_organization's own slug rule so the error surfaces before
  // we create an auth user we'd have to roll back.
  slug: z
    .string()
    .trim()
    .regex(
      /^[a-z0-9][a-z0-9-]{1,62}$/,
      "Slug must be 2–63 chars: lowercase letters, digits, and dashes."
    ),
  ownerName: z.string().trim().min(1, "Owner name is required.").max(200),
  ownerEmail: z.string().trim().email("Enter a valid owner email.").max(200),
})

export type ProvisionOrgInputT = z.infer<typeof ProvisionOrgInput>

export type ProvisionOrgResult =
  | { ok: true; orgId: string; ownerEmail: string; tempPassword: string }
  | { ok: false; error: string }

/**
 * Provision a brand-new builder organization as a full subscriber (no trial).
 * The operator surface: gated to the legacy-org owner, then delegates the
 * end-to-end sequence (create owner auth user → promote to staff → create the
 * org seeded from Hines → land the owner in it, with rollback on failure) to
 * the shared `provisionOrgCore`. The temp password is generated inside the core
 * and returned once to share — it never round-trips from the client.
 */
export async function provisionOrganization(
  input: ProvisionOrgInputT
): Promise<ProvisionOrgResult> {
  const me = await requireStaff()
  const parsed = ProvisionOrgInput.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." }
  }
  const { orgName, slug, ownerName, ownerEmail } = parsed.data

  const supabase = await createSupabaseServerClient()
  if (!(await isLegacyOrgOwner(supabase, me.id))) {
    return {
      ok: false,
      error: "Only the platform owner can provision new organizations.",
    }
  }

  const admin = createSupabaseAdminClient()
  if (!admin) {
    return { ok: false, error: "Server admin (service role) is not configured." }
  }

  const result = await provisionOrgCore(admin, {
    orgName,
    slug,
    ownerName,
    ownerEmail,
    lifecycle: "active_subscriber",
  })
  if (!result.ok) return result

  revalidatePath("/", "layout")
  return {
    ok: true,
    orgId: result.orgId,
    ownerEmail: result.ownerEmail,
    tempPassword: result.tempPassword,
  }
}

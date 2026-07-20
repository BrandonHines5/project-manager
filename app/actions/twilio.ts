"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"
import { requireSession } from "@/lib/auth"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { createSupabaseAdminClient } from "@/lib/supabase/admin"
import { appUrl } from "@/lib/email"
import { upsertOrgIntegration } from "@/lib/integrations/org"
import {
  twilioConfigured,
  searchAvailableNumbers,
  buyTwilioNumber,
  releaseTwilioNumber as releaseTwilioNumberResource,
  resolveTwilioConfig,
  TWILIO_PROVIDER,
} from "@/lib/twilio"

// Platform-managed SMS provisioning (S — messaging). A builder org gets its
// own Twilio number with one click — no API key, unlike the OpenPhone/Quo
// path (which stays as-is for the legacy Hines org). org_integrations is
// service-role-only, so these actions gate authorization at the app layer:
// owner/admin of the target org, the same trust tier as saveQuoIntegration.

/** Owner/admin membership check against the target org (app-layer gate). */
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

const ProvisionSchema = z.object({
  orgId: z.string().uuid(),
  // Optional 3-digit US area code preference; blank = any available number.
  areaCode: z
    .union([z.literal(""), z.string().regex(/^\d{3}$/, "Area code must be 3 digits")])
    .optional(),
})

/**
 * Provisions a dedicated Twilio number for the org and wires its inbound-SMS
 * webhook. Idempotent — if the org already has a number, returns it without
 * buying another. Owner/admin only; no-ops with a friendly message when the
 * platform Twilio account isn't configured.
 */
export async function provisionTwilioNumber(
  input: z.infer<typeof ProvisionSchema>
): Promise<{ ok: true; phoneNumber: string } | { ok: false; error: string }> {
  const profile = await requireSession()
  const parsed = ProvisionSchema.safeParse(input)
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid request.",
    }
  }
  const { orgId, areaCode } = parsed.data

  const supabase = await createSupabaseServerClient()
  if (!(await requireOrgAdmin(supabase, orgId, profile.id))) {
    return {
      ok: false,
      error: "Only organization owners and admins can set up text messaging.",
    }
  }

  if (!twilioConfigured()) {
    return {
      ok: false,
      error: "Text messaging isn't available yet — contact support.",
    }
  }

  const admin = createSupabaseAdminClient()
  if (!admin) return { ok: false, error: "Server storage is not configured." }

  // Idempotent: never buy a second number for an org that already has one.
  const existing = await resolveTwilioConfig(orgId)
  if (existing) return { ok: true, phoneNumber: existing.phoneNumber }

  const candidates = await searchAvailableNumbers(areaCode || undefined)
  if (!candidates.length) {
    return {
      ok: false,
      error: areaCode
        ? `No numbers available for area code ${areaCode}. Try another.`
        : "No numbers are currently available. Try again shortly.",
    }
  }

  const bought = await buyTwilioNumber({
    phoneNumber: candidates[0].phoneNumber,
    smsUrl: appUrl("/api/inbound/twilio"),
  })
  if (!bought.ok) return { ok: false, error: bought.error }

  try {
    await upsertOrgIntegration(admin, orgId, TWILIO_PROVIDER, {
      enabled: true,
      config: { phoneNumber: bought.phoneNumber, phoneNumberSid: bought.sid },
    })
  } catch (e) {
    // The number was bought but we couldn't record it — release it so we don't
    // strand (and keep paying for) an unlinked number.
    await releaseTwilioNumberResource(bought.sid)
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Couldn't save the number.",
    }
  }

  revalidatePath("/settings/organization")
  return { ok: true, phoneNumber: bought.phoneNumber }
}

const ReleaseSchema = z.object({ orgId: z.string().uuid() })

/**
 * Releases the org's Twilio number (stops billing) and clears the integration.
 * Owner/admin only. Clears the stored config even if the Twilio release call
 * fails, so a stale row never keeps routing to a number we intended to drop.
 */
export async function releaseTwilioNumber(
  input: z.infer<typeof ReleaseSchema>
): Promise<{ ok: boolean; error?: string }> {
  const profile = await requireSession()
  const parsed = ReleaseSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: "Invalid request." }
  const { orgId } = parsed.data

  const supabase = await createSupabaseServerClient()
  if (!(await requireOrgAdmin(supabase, orgId, profile.id))) {
    return {
      ok: false,
      error: "Only organization owners and admins can change text messaging.",
    }
  }

  const admin = createSupabaseAdminClient()
  if (!admin) return { ok: false, error: "Server storage is not configured." }

  const current = await resolveTwilioConfig(orgId)
  if (current?.phoneNumberSid) {
    await releaseTwilioNumberResource(current.phoneNumberSid)
  }

  try {
    await upsertOrgIntegration(admin, orgId, TWILIO_PROVIDER, {
      enabled: false,
      config: {},
    })
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Save failed." }
  }

  revalidatePath("/settings/organization")
  return { ok: true }
}

"use server"

import { z } from "zod"
import { revalidatePath } from "next/cache"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { requireSession } from "@/lib/auth"

const Input = z
  .object({
    profile_id: z.string().uuid().nullish(),
    company_id: z.string().uuid().nullish(),
    category: z.enum([
      "assignments",
      "bids_pos",
      "comments",
      "client_decisions",
      "reminders",
    ]),
    channel: z.enum(["in_app", "email", "sms"]),
    enabled: z.boolean(),
  })
  .refine(
    (v) => (!!v.profile_id && !v.company_id) || (!v.profile_id && !!v.company_id),
    { message: "Provide exactly one of profile_id or company_id" }
  )

export type SaveNotificationPreferenceInput = z.input<typeof Input>

/**
 * Set one (owner, category, channel) preference. A user may edit only their
 * own profile preferences; staff may edit any profile's or any company's. The
 * app-layer check below is a UX guard — RLS (notif_pref_self /
 * notif_pref_staff_all) is the real gate, so a non-staff caller physically
 * can't write another owner's row.
 */
export async function saveNotificationPreference(
  input: SaveNotificationPreferenceInput
) {
  const me = await requireSession()
  const parsed = Input.parse(input)

  const editingOwnProfile =
    parsed.profile_id === me.id && !parsed.company_id
  if (me.role !== "staff" && !editingOwnProfile) {
    throw new Error("You can only change your own notification settings.")
  }

  const supabase = await createSupabaseServerClient()

  // Find an existing row for this owner+category+channel, then update or
  // insert. (A manual read/write avoids upsert quirks with the partial unique
  // indexes.)
  let lookup = supabase
    .from("notification_preferences")
    .select("id")
    .eq("category", parsed.category)
    .eq("channel", parsed.channel)
  lookup = parsed.profile_id
    ? lookup.eq("profile_id", parsed.profile_id)
    : lookup.eq("company_id", parsed.company_id!)
  const { data: existing, error: lookupErr } = await lookup.maybeSingle()
  if (lookupErr) throw new Error(lookupErr.message)

  if (existing) {
    const { error } = await supabase
      .from("notification_preferences")
      .update({ enabled: parsed.enabled })
      .eq("id", existing.id)
    if (error) throw new Error(error.message)
  } else {
    const { error } = await supabase.from("notification_preferences").insert({
      profile_id: parsed.profile_id ?? null,
      company_id: parsed.company_id ?? null,
      category: parsed.category,
      channel: parsed.channel,
      enabled: parsed.enabled,
    })
    if (error && (error as { code?: string }).code === "23505") {
      // Lost a read-then-write race (duplicate click / multi-tab) — someone
      // inserted the same (owner, category, channel) first. Fall back to update.
      const col = parsed.profile_id ? "profile_id" : "company_id"
      const val = parsed.profile_id ?? parsed.company_id!
      const { error: retryErr } = await supabase
        .from("notification_preferences")
        .update({ enabled: parsed.enabled })
        .eq(col, val)
        .eq("category", parsed.category)
        .eq("channel", parsed.channel)
      if (retryErr) throw new Error(retryErr.message)
    } else if (error) {
      throw new Error(error.message)
    }
  }

  revalidatePath("/settings/notifications")
  return { ok: true }
}

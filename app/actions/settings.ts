"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"
import { requireStaff } from "@/lib/auth"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { getActiveOrgId } from "@/lib/org"
import {
  baseTag,
  normalizeTag,
  parseTagGroupConfig,
  type TemplateTagConfig,
} from "@/lib/template-tags"
import {
  DELAY_REASONS_KEY,
  parseDelayReasons,
  slugifyReason,
  type DelayReason,
} from "@/lib/delays"

// app_settings key for the template-tag registry + either/or groups
// (migration 0077). The settings page reads app_settings directly with the
// same literal.
const TEMPLATE_TAG_CONFIG_KEY = "template_tag_groups"

/**
 * Org-wide template-tag registry (managed vocabulary) + either/or groups. Read
 * by the project-creation questionnaire (only .groups matter there) and the
 * settings editor. Staff-only — mirrors getTemplateProfile's requireStaff.
 */
export async function getTemplateTagConfig(): Promise<TemplateTagConfig> {
  await requireStaff()
  const supabase = await createSupabaseServerClient()
  const { data } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", TEMPLATE_TAG_CONFIG_KEY)
    .maybeSingle()
  return parseTagGroupConfig(data?.value ?? null)
}

export type TagUsage = { tag: string; uses: number }

/**
 * Distinct base tags actually carried by schedule items / decisions, with
 * usage counts. Backed by the template_tag_usage() RPC (migration 0082) so it
 * counts every row, not just the first 1000 a client select would return.
 */
export async function getTemplateTagUsage(): Promise<TagUsage[]> {
  await requireStaff()
  const supabase = await createSupabaseServerClient()
  const { data, error } = await supabase.rpc("template_tag_usage")
  if (error) return []
  return (data ?? []).map((r) => ({ tag: r.tag, uses: Number(r.uses) }))
}

const GroupInput = z.object({
  id: z.string().min(1).max(100),
  label: z.string().trim().min(1, "Every group needs a name").max(100),
  required: z.boolean(),
  options: z.array(z.string()).max(30),
})
const ConfigInput = z.object({
  tags: z.array(z.string()).max(500),
  groups: z.array(GroupInput).max(50),
  // Base tags to delete from every schedule_item / decision that carries them.
  strip: z.array(z.string()).max(500).optional(),
})

export type SaveTagConfigResult =
  | { ok: true; stripped: number }
  | { ok: false; error: string }

/**
 * Replace the whole tag config (managed vocabulary + either/or groups) and,
 * for any tags in `strip`, delete them off the items/decisions that carry
 * them first (via the strip_template_tag RPC). Option tags are normalized to
 * positive base tags and every group must keep at least two of them, so each
 * group stays a real either/or choice.
 */
export async function saveTemplateTagConfig(input: {
  tags: string[]
  groups: { id: string; label: string; required: boolean; options: string[] }[]
  strip?: string[]
}): Promise<SaveTagConfigResult> {
  const profile = await requireStaff()
  const parsed = ConfigInput.safeParse(input)
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid settings",
    }
  }
  const tags = [
    ...new Set(
      parsed.data.tags.map((t) => baseTag(normalizeTag(t))).filter(Boolean)
    ),
  ]
  const groups = parsed.data.groups.map((g) => ({
    id: g.id,
    label: g.label.trim(),
    required: g.required,
    options: [
      ...new Set(g.options.map((o) => baseTag(normalizeTag(o))).filter(Boolean)),
    ],
  }))
  const labels = new Set<string>()
  for (const g of groups) {
    if (g.options.length < 2) {
      return {
        ok: false,
        error: `"${g.label}" needs at least two options to be an either/or choice.`,
      }
    }
    const key = g.label.toLowerCase()
    if (labels.has(key)) {
      return { ok: false, error: `Two groups are both named "${g.label}".` }
    }
    labels.add(key)
  }

  const supabase = await createSupabaseServerClient()

  // Strip removed tags off items/decisions BEFORE persisting the config, so a
  // failure here leaves the tag still listed rather than silently orphaned.
  let stripped = 0
  const stripTags = [
    ...new Set(
      (parsed.data.strip ?? [])
        .map((t) => baseTag(normalizeTag(t)))
        .filter(Boolean)
    ),
  ]
  for (const tag of stripTags) {
    const { data, error } = await supabase.rpc("strip_template_tag", {
      p_tag: tag,
    })
    if (error) return { ok: false, error: error.message }
    stripped += typeof data === "number" ? data : 0
  }

  const { error } = await supabase.from("app_settings").upsert(
    {
      org_id: await getActiveOrgId(supabase),
      key: TEMPLATE_TAG_CONFIG_KEY,
      value: JSON.stringify({ tags, groups }),
      updated_by: profile.id,
    },
    { onConflict: "org_id,key" }
  )
  if (error) return { ok: false, error: error.message }
  revalidatePath("/settings/template-tags")
  return { ok: true, stripped }
}

// ---------------------------------------------------------------------------
// Delay reasons (Settings → Delay reasons)
// ---------------------------------------------------------------------------

/**
 * The staff-editable list of schedule delay reasons. Read by the settings
 * editor and the (staff-gated) Delay Report; the schedule page reads
 * app_settings directly under the caller's session. Post-0079 the
 * app_settings read policy is staff-only, so non-staff schedule viewers fall
 * back to DEFAULT_DELAY_REASONS — harmless, since only staff ever log a delay
 * or move a baselined item.
 */
export async function getDelayReasons(): Promise<DelayReason[]> {
  await requireStaff()
  const supabase = await createSupabaseServerClient()
  const { data } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", DELAY_REASONS_KEY)
    .maybeSingle()
  return parseDelayReasons(data?.value ?? null)
}

const DelayReasonsInput = z.object({
  reasons: z
    .array(
      z.object({
        value: z.string().max(60).optional(),
        label: z.string().trim().min(1, "Every reason needs a name").max(60),
      })
    )
    .min(1, "Keep at least one delay reason")
    .max(50),
})

export type SaveDelayReasonsResult =
  | { ok: true; reasons: DelayReason[] }
  | { ok: false; error: string }

/**
 * Replace the whole delay-reason list. Each reason gets a stable slug `value`
 * (kept as-is when provided, else derived from the label) so renaming a reason
 * never orphans the historical schedule_delays rows that point at it.
 */
export async function saveDelayReasons(input: {
  reasons: { value?: string; label: string }[]
}): Promise<SaveDelayReasonsResult> {
  const profile = await requireStaff()
  const parsed = DelayReasonsInput.safeParse(input)
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid delay reasons",
    }
  }

  const reasons: DelayReason[] = []
  const seen = new Set<string>()
  for (const r of parsed.data.reasons) {
    const label = r.label.trim()
    const value = slugifyReason(r.value?.trim() ? r.value : label)
    if (!value) {
      return {
        ok: false,
        error: `"${label}" needs at least one letter or number.`,
      }
    }
    if (seen.has(value)) {
      return { ok: false, error: `Two reasons resolve to the same id ("${value}").` }
    }
    seen.add(value)
    reasons.push({ value, label })
  }

  const supabase = await createSupabaseServerClient()
  const { error } = await supabase.from("app_settings").upsert(
    {
      org_id: await getActiveOrgId(supabase),
      key: DELAY_REASONS_KEY,
      value: JSON.stringify(reasons),
      updated_by: profile.id,
    },
    { onConflict: "org_id,key" }
  )
  if (error) return { ok: false, error: error.message }
  revalidatePath("/settings/delay-reasons")
  return { ok: true, reasons }
}

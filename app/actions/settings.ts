"use server"

import { z } from "zod"
import { requireStaff } from "@/lib/auth"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import {
  baseTag,
  normalizeTag,
  parseTagGroupConfig,
  type TemplateTagConfig,
} from "@/lib/template-tags"

// app_settings key for the either/or template-tag groups (migration 0077).
// The settings page reads app_settings directly with the same literal.
const TEMPLATE_TAG_CONFIG_KEY = "template_tag_groups"

/**
 * Org-wide either/or template-tag groups. Read by the project-creation
 * questionnaire (required groups gate "Create project") and the settings
 * editor. Staff-only — mirrors getTemplateProfile's requireStaff.
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

const GroupInput = z.object({
  id: z.string().min(1).max(100),
  label: z.string().trim().min(1, "Every group needs a name").max(100),
  required: z.boolean(),
  options: z.array(z.string()).max(30),
})
const ConfigInput = z.object({ groups: z.array(GroupInput).max(50) })

export type SaveTagConfigResult = { ok: true } | { ok: false; error: string }

/**
 * Replace the whole tag-group config. Option tags are normalized to positive
 * base tags and every group must keep at least two of them, so each group is
 * a real either/or choice.
 */
export async function saveTemplateTagConfig(input: {
  groups: { id: string; label: string; required: boolean; options: string[] }[]
}): Promise<SaveTagConfigResult> {
  const profile = await requireStaff()
  const parsed = ConfigInput.safeParse(input)
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid settings",
    }
  }
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
  const { error } = await supabase.from("app_settings").upsert(
    {
      key: TEMPLATE_TAG_CONFIG_KEY,
      value: JSON.stringify({ groups }),
      updated_by: profile.id,
    },
    { onConflict: "key" }
  )
  if (error) return { ok: false, error: error.message }
  return { ok: true }
}

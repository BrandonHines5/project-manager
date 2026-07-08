import { requireStaff } from "@/lib/auth"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { collectBaseTags, parseTagGroupConfig } from "@/lib/template-tags"
import { TemplateTagsSettingsClient } from "./template-tags-settings-client"

export const metadata = { title: "Template tags — Hines Homes" }
export const dynamic = "force-dynamic"

export default async function TemplateTagsSettingsPage() {
  // Staff-only config; requireStaff redirects clients/trades to /projects.
  await requireStaff()
  const supabase = await createSupabaseServerClient()

  const [{ data: cfg }, { data: items }, { data: decisions }] =
    await Promise.all([
      supabase
        .from("app_settings")
        .select("value")
        .eq("key", "template_tag_groups")
        .maybeSingle(),
      supabase.from("schedule_items").select("template_tags"),
      supabase.from("decisions").select("template_tags"),
    ])

  const config = parseTagGroupConfig(cfg?.value ?? null)
  // Existing tag vocabulary across every template item + decision, so the
  // option editor can suggest reusing a tag instead of coining a variant.
  const existingTags = collectBaseTags([
    ...(items ?? []).map((r) => r.template_tags),
    ...(decisions ?? []).map((r) => r.template_tags),
  ])

  return (
    <TemplateTagsSettingsClient
      initialGroups={config.groups}
      existingTags={existingTags}
    />
  )
}

import { requireStaff } from "@/lib/auth"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { parseTagGroupConfig } from "@/lib/template-tags"
import { TemplateTagsSettingsClient } from "./template-tags-settings-client"

export const metadata = { title: "Template tags — Hines Homes" }
export const dynamic = "force-dynamic"

export default async function TemplateTagsSettingsPage() {
  // Staff-only config; requireStaff redirects clients/trades to /projects.
  await requireStaff()
  const supabase = await createSupabaseServerClient()

  // Usage counts come from the template_tag_usage() RPC (migration 0082) which
  // counts every row in the database — a client select would cap at 1000 rows
  // and silently drop tags that only appear on later items.
  const [{ data: cfg }, { data: usageRows }] = await Promise.all([
    supabase
      .from("app_settings")
      .select("value")
      .eq("key", "template_tag_groups")
      .maybeSingle(),
    supabase.rpc("template_tag_usage"),
  ])

  const config = parseTagGroupConfig(cfg?.value ?? null)
  const usage: Record<string, number> = {}
  for (const r of usageRows ?? []) {
    if (r.tag) usage[r.tag] = Number(r.uses)
  }

  return (
    <TemplateTagsSettingsClient
      initialTags={config.tags}
      initialGroups={config.groups}
      initialUsage={usage}
    />
  )
}

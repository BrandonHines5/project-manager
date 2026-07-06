import { notFound } from "next/navigation"
import { MapPin } from "lucide-react"
import { requireStaff } from "@/lib/auth"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { getOnsitePrompts } from "@/lib/onsite/prompts"
import { Walkthrough } from "@/components/onsite/walkthrough"
import { OnsiteClient } from "./onsite-client"

export default async function OnsitePage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  await requireStaff()
  const { id } = await params
  const supabase = await createSupabaseServerClient()
  const { data: project, error } = await supabase
    .from("projects")
    .select("id, name, address")
    .eq("id", id)
    .maybeSingle()
  if (error) throw new Error(`Failed to load project: ${error.message}`)
  if (!project) notFound()

  const prompts = await getOnsitePrompts(supabase, project.id)

  return (
    <div className="max-w-3xl mx-auto px-4 md:px-6 py-6">
      <div className="mb-4 flex items-center gap-2">
        <MapPin className="h-5 w-5 text-brand-600" />
        <h2 className="text-lg font-semibold">Onsite check-in</h2>
      </div>
      <Walkthrough projectId={project.id} projectName={project.name} />
      <h3 className="text-sm font-semibold mb-1">Quick updates</h3>
      <p className="text-sm text-muted mb-4">
        Schedule items for {project.name}
        {project.address ? ` (${project.address})` : ""} that need a quick
        yes/no/date update right now.
      </p>
      <OnsiteClient projectId={project.id} prompts={prompts} />
    </div>
  )
}

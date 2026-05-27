import { notFound } from "next/navigation"
import { MapPin } from "lucide-react"
import { requireStaff } from "@/lib/auth"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { getOnsitePrompts } from "@/lib/onsite/prompts"
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
    .select("id, name, address, latitude, longitude")
    .eq("id", id)
    .maybeSingle()
  if (error) throw new Error(`Failed to load project: ${error.message}`)
  if (!project) notFound()

  const hasCoords = project.latitude != null && project.longitude != null
  const prompts = hasCoords ? await getOnsitePrompts(supabase, project.id) : []

  return (
    <div className="max-w-3xl mx-auto px-4 md:px-6 py-6">
      <div className="mb-4 flex items-center gap-2">
        <MapPin className="h-5 w-5 text-brand-600" />
        <h2 className="text-lg font-semibold">Onsite check-in</h2>
      </div>
      <p className="text-sm text-muted mb-6">
        When you&rsquo;re within 200m of {project.name}
        {project.address ? ` (${project.address})` : ""}, this page surfaces
        schedule items that need a quick yes/no/date update.
      </p>
      <OnsiteClient
        projectId={project.id}
        latitude={project.latitude}
        longitude={project.longitude}
        prompts={prompts}
      />
    </div>
  )
}

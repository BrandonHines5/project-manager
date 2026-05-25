import { requireStaff } from "@/lib/auth"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { listAvailableDashboardProjects } from "@/lib/dashboard"
import { NewProjectForm } from "./new-project-form"

export const metadata = { title: "New project — Hines Homes" }

// Always render fresh — the available list changes whenever a sales person
// adds a project on the dashboard side, and we don't want stale options.
export const dynamic = "force-dynamic"

export default async function NewProjectPage() {
  await requireStaff()
  const supabase = await createSupabaseServerClient()
  // Best-effort: if the dashboard integration isn't configured or the
  // dashboard is unreachable, we fall back to the "create blank" path.
  // Templates list comes from PM itself — every existing project is a
  // candidate template (staff name the canonical one clearly, e.g.
  // "TEMPLATE - Standard Build").
  const [available, { data: templates }] = await Promise.all([
    listAvailableDashboardProjects(),
    supabase
      .from("projects")
      .select("id, project_number, name, status")
      .order("name", { ascending: true }),
  ])
  return (
    <div className="max-w-2xl mx-auto px-4 md:px-6 py-6">
      <h1 className="text-2xl font-semibold tracking-tight mb-1">New project</h1>
      <p className="text-sm text-muted mb-6">
        Projects start on the dashboard with the client&apos;s contact info.
        Pick one below to import it here, start from a template to copy
        another project&apos;s schedule + selections, or use &ldquo;Create
        blank&rdquo; for a project that isn&apos;t on the dashboard yet.
      </p>
      <NewProjectForm available={available} templates={templates ?? []} />
    </div>
  )
}

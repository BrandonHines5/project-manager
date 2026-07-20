import { requireStaff } from "@/lib/auth"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { getActiveOrgId } from "@/lib/org"
import {
  dashboardBaseUrl,
  listAvailableDashboardProjects,
} from "@/lib/dashboard"
import { NewProjectForm } from "./new-project-form"

export const metadata = { title: "New project — BuildFox" }

// Always render fresh — the available list changes whenever a sales person
// adds a project on the dashboard side, and we don't want stale options.
export const dynamic = "force-dynamic"

export default async function NewProjectPage() {
  const profile = await requireStaff()
  const supabase = await createSupabaseServerClient()
  // The dashboard project picker is Hines-only (its own external site).
  const orgId = await getActiveOrgId(supabase, profile.id)
  // Best-effort: if the dashboard integration isn't configured or the
  // dashboard is unreachable, we fall back to the "create blank" path.
  // The template list is restricted to projects explicitly flagged as
  // templates (Edit project → "Use as template") — staff copy from a curated
  // set of templates, not from every job in the system.
  const [available, templatesResult] = await Promise.all([
    listAvailableDashboardProjects(orgId),
    supabase
      .from("projects")
      .select("id, project_number, name, status")
      .eq("is_template", true)
      .order("name", { ascending: true }),
  ])
  // Surface query failures in the logs but don't block the page — staff
  // can still create blank or dashboard-pulled projects without the
  // template picker. Mirrors listAvailableDashboardProjects's fallback.
  if (templatesResult.error) {
    console.warn(
      "[NewProjectPage] templates query failed:",
      templatesResult.error.message
    )
  }
  const templates = templatesResult.data ?? []
  return (
    <div className="max-w-2xl mx-auto px-4 md:px-6 py-6">
      <h1 className="text-2xl font-semibold tracking-tight mb-1">New project</h1>
      <p className="text-sm text-muted mb-6">
        Projects start on the dashboard with the client&apos;s contact info.
        Pick one below to import it here, start from a template to copy
        another project&apos;s schedule + selections, or use &ldquo;Create
        blank&rdquo; for a project that isn&apos;t on the dashboard yet.
      </p>
      <NewProjectForm
        available={available}
        templates={templates}
        dashboardBaseUrl={dashboardBaseUrl()}
      />
    </div>
  )
}

import { notFound } from "next/navigation"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { requireStaff } from "@/lib/auth"
import { RolesClient } from "./roles-client"

export const metadata = { title: "Roles — Hines Homes" }

export default async function ProjectRolesPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  await requireStaff()
  const { id: projectId } = await params
  const supabase = await createSupabaseServerClient()

  // Surface read failures rather than swallowing them: this is a mutation
  // surface, so a DB/RLS error that silently rendered every role as unassigned
  // could lead staff to overwrite real mappings from a bad snapshot.
  const { data: project, error: projectErr } = await supabase
    .from("projects")
    .select("id, name, is_template, project_manager")
    .eq("id", projectId)
    .maybeSingle()
  if (projectErr) throw new Error(projectErr.message)
  if (!project) notFound()

  const [rolesRes, membersRes, profilesRes, companiesRes] = await Promise.all([
    supabase
      .from("roles")
      .select("id, name, kind, position")
      .order("position", { ascending: true })
      .order("name", { ascending: true }),
    supabase
      .from("project_role_members")
      .select("role_id, profile_id, company_id")
      .eq("project_id", projectId),
    supabase
      .from("profiles")
      .select("id, full_name, email, role")
      // Clients can never fill a role — exclude them server-side so their
      // names/emails aren't serialized into the page payload.
      .neq("role", "client")
      .order("full_name", { ascending: true }),
    supabase
      .from("companies")
      .select("id, name, type, trade_category")
      .neq("type", "client")
      .order("name", { ascending: true }),
  ])
  const readErr =
    rolesRes.error ?? membersRes.error ?? profilesRes.error ?? companiesRes.error
  if (readErr) throw new Error(readErr.message)

  return (
    <RolesClient
      projectId={project.id}
      isTemplate={project.is_template}
      projectManager={project.project_manager}
      roles={rolesRes.data ?? []}
      members={membersRes.data ?? []}
      profiles={profilesRes.data ?? []}
      companies={companiesRes.data ?? []}
    />
  )
}

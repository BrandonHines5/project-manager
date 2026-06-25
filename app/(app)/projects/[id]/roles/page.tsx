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

  const { data: project } = await supabase
    .from("projects")
    .select("id, name, is_template, project_manager")
    .eq("id", projectId)
    .maybeSingle()
  if (!project) notFound()

  const [
    { data: roles },
    { data: members },
    { data: profiles },
    { data: companies },
  ] = await Promise.all([
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
      .order("full_name", { ascending: true }),
    supabase
      .from("companies")
      .select("id, name, type, trade_category")
      .neq("type", "client")
      .order("name", { ascending: true }),
  ])

  return (
    <RolesClient
      projectId={project.id}
      isTemplate={project.is_template}
      projectManager={project.project_manager}
      roles={roles ?? []}
      members={members ?? []}
      profiles={profiles ?? []}
      companies={companies ?? []}
    />
  )
}

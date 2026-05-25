import Link from "next/link"
import { notFound } from "next/navigation"
import { ArrowLeft, ExternalLink } from "lucide-react"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { requireSession } from "@/lib/auth"
import { Badge } from "@/components/ui/badge"
import { formatCurrency } from "@/lib/utils"
import { ProjectTabs } from "./project-tabs"
import { MembersButton } from "@/components/projects/members-dialog"
import { DuplicateProjectButton } from "@/components/projects/duplicate-button"
import type { Enums } from "@/lib/db/types"

const STATUS_LABEL: Record<Enums<"project_status">, string> = {
  lead: "Lead",
  pre_construction: "Pre-construction",
  active: "Active",
  on_hold: "On hold",
  complete: "Complete",
  cancelled: "Cancelled",
}

export default async function ProjectDetailLayout({
  children,
  params,
}: {
  children: React.ReactNode
  params: Promise<{ id: string }>
}) {
  const profile = await requireSession()
  const { id } = await params
  const supabase = await createSupabaseServerClient()
  const { data: project } = await supabase
    .from("projects")
    .select(
      "id, project_number, name, address, status, contract_price, dashboard_url"
    )
    .eq("id", id)
    .maybeSingle()

  if (!project) notFound()

  const isStaff = profile.role === "staff"
  let members: { profile_id: string; role_on_project: string | null }[] = []
  let memberProfiles: {
    id: string
    full_name: string
    email: string
    role: "staff" | "trade" | "client"
  }[] = []
  if (isStaff) {
    const { data: m } = await supabase
      .from("project_members")
      .select("profile_id, role_on_project")
      .eq("project_id", project.id)
    members = m ?? []
    const { data: ps } = await supabase
      .from("profiles")
      .select("id, full_name, email, role")
      .order("full_name")
    memberProfiles = (ps ?? []) as typeof memberProfiles
  }

  return (
    <div className="flex flex-col">
      <div className="bg-surface border-b border-border">
        <div className="max-w-7xl mx-auto px-4 md:px-6 pt-4 pb-3">
          <Link
            href="/projects"
            className="inline-flex items-center gap-1 text-xs text-muted hover:text-foreground mb-2"
          >
            <ArrowLeft className="h-3 w-3" /> All projects
          </Link>
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-xl font-semibold tracking-tight">
                  {project.name}
                </h1>
                <Badge tone="muted">#{project.project_number}</Badge>
                <Badge tone="brand">{STATUS_LABEL[project.status]}</Badge>
              </div>
              {project.address && (
                <p className="text-sm text-muted mt-0.5">{project.address}</p>
              )}
            </div>
            <div className="flex items-center gap-4 text-sm">
              {project.contract_price != null && (
                <div>
                  <div className="text-[11px] uppercase tracking-wide text-muted">
                    Contract
                  </div>
                  <div className="font-semibold tabular-nums">
                    {formatCurrency(project.contract_price)}
                  </div>
                </div>
              )}
              {isStaff && (
                <MembersButton
                  projectId={project.id}
                  members={members}
                  profiles={memberProfiles}
                />
              )}
              {isStaff && (
                <DuplicateProjectButton
                  sourceProjectId={project.id}
                  sourceName={project.name}
                  sourceProjectNumber={project.project_number}
                />
              )}
              {project.dashboard_url && (
                <a
                  href={project.dashboard_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-brand-600 hover:underline"
                >
                  Dashboard
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              )}
            </div>
          </div>
        </div>
        <ProjectTabs projectId={project.id} role={profile.role} />
      </div>
      <div className="flex-1">{children}</div>
    </div>
  )
}

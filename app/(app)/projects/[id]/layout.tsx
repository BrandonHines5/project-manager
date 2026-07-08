import Link from "next/link"
import { notFound } from "next/navigation"
import { ArrowLeft, ExternalLink } from "lucide-react"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { requireSession } from "@/lib/auth"
import { Badge } from "@/components/ui/badge"
import { MembersButton } from "@/components/projects/members-dialog"
import { DuplicateProjectButton } from "@/components/projects/duplicate-button"
import { EditProjectButton } from "@/components/projects/edit-project-dialog"
import { SyncDashboardButton } from "@/components/projects/sync-dashboard-button"
import { brandForProjectType } from "@/lib/brand"
import { crmStatusTone } from "@/lib/crm-status"
import type { Enums } from "@/lib/db/types"

// The enum mirrors the CRM's statuses, so labels are the CRM's exact words.
const STATUS_LABEL: Record<Enums<"project_status">, string> = {
  upcoming: "Upcoming",
  in_work: "In Work",
  inventory: "Inventory",
  paused: "Paused",
  complete: "Complete",
  warranty: "Warranty",
  cancelled: "Cancelled",
}

// Mirrors the tone map in the sidebar / projects table so an un-synced project
// (no crm_status) still gets a status-appropriate badge colour here.
const STATUS_TONE: Record<
  Enums<"project_status">,
  "brand" | "muted" | "warning" | "success" | "danger" | "info"
> = {
  upcoming: "info",
  in_work: "brand",
  inventory: "info",
  paused: "warning",
  complete: "success",
  warranty: "info",
  cancelled: "danger",
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
      "id, project_number, name, address, status, crm_status, project_type, dashboard_url, project_manager, client_name, client_email, client_phone, client_name_2, client_email_2, client_phone_2, contract_price, cost_plus, is_template, start_date, target_completion_date, notes"
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
    // These two reads are independent — run them together instead of serially
    // (this layout renders on every project page, so the saved round-trip counts).
    const [{ data: m }, { data: ps }] = await Promise.all([
      supabase
        .from("project_members")
        .select("profile_id, role_on_project")
        .eq("project_id", project.id),
      supabase
        .from("profiles")
        .select("id, full_name, email, role")
        .order("full_name"),
    ])
    members = m ?? []
    memberProfiles = (ps ?? []) as typeof memberProfiles
  }

  return (
    <div className="flex flex-col">
      <div className="bg-surface border-b border-border">
        <div className="max-w-7xl mx-auto px-4 md:px-6 pt-4 pb-3">
          {/* Mobile-only: desktop has the jobs list sidebar for navigating
              back, so the extra link would just add header height there. */}
          <Link
            href="/projects"
            className="inline-flex items-center gap-1 text-xs text-muted hover:text-foreground mb-2 lg:hidden"
          >
            <ArrowLeft className="h-3 w-3" /> All projects
          </Link>
          {(() => {
            // Client-facing brand for this job (residential → Hines Homes,
            // commercial → MJV Building Group).
            const brand = brandForProjectType(project.project_type)
            return (
              <div className="flex items-center gap-2 mb-2">
                <div className="h-7 w-7 rounded-md bg-brand-500 text-white flex items-center justify-center font-bold text-[11px]">
                  {/* Static SVG mark from /public — next/image adds no benefit for SVGs. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={brand.mark} alt={brand.name} className="h-5 w-5" />
                </div>
                <span className="text-sm font-semibold">{brand.name}</span>
              </div>
            )
          })()}
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-xl font-semibold tracking-tight">
                  {project.name}
                </h1>
                <Badge tone="muted">#{project.project_number}</Badge>
                {project.crm_status ? (
                  <Badge tone={crmStatusTone(project.crm_status)}>
                    {project.crm_status}
                  </Badge>
                ) : (
                  <Badge tone={STATUS_TONE[project.status]}>
                    {STATUS_LABEL[project.status]}
                  </Badge>
                )}
                {project.is_template && <Badge tone="warning">Template</Badge>}
              </div>
              {project.address && (
                <p className="text-sm text-muted mt-0.5">{project.address}</p>
              )}
              {isStaff &&
                (() => {
                  // The dashboard tracks up to two clients per project; list
                  // every one we have, each with their email + phone.
                  const clients = [
                    {
                      name: project.client_name,
                      email: project.client_email,
                      phone: project.client_phone,
                    },
                    {
                      name: project.client_name_2,
                      email: project.client_email_2,
                      phone: project.client_phone_2,
                    },
                  ].filter((c) => c.name)
                  if (clients.length === 0) return null
                  return (
                    <div className="text-xs text-muted mt-1">
                      <span>{clients.length > 1 ? "Clients:" : "Client:"}</span>
                      <ul className="inline">
                        {clients.map((c, i) => (
                          <li key={i} className="inline">
                            {i > 0 && <span className="mx-1">•</span>}
                            <span className="text-foreground">{c.name}</span>
                            {c.email && (
                              <>
                                {" · "}
                                <a
                                  href={`mailto:${c.email}`}
                                  className="text-brand-600 hover:underline"
                                >
                                  {c.email}
                                </a>
                              </>
                            )}
                            {c.phone && (
                              <>
                                {" · "}
                                <a
                                  href={`tel:${c.phone}`}
                                  className="text-brand-600 hover:underline"
                                >
                                  {c.phone}
                                </a>
                              </>
                            )}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )
                })()}
              {isStaff && project.project_manager && (
                <p className="text-xs text-muted mt-1">
                  PM:{" "}
                  <span className="text-foreground">
                    {project.project_manager}
                  </span>
                </p>
              )}
            </div>
            <div className="flex items-center gap-4 text-sm">
              {isStaff && (
                <EditProjectButton
                  project={{
                    id: project.id,
                    name: project.name,
                    address: project.address,
                    status: project.status,
                    project_type: project.project_type,
                    contract_price: project.contract_price,
                    start_date: project.start_date,
                    target_completion_date: project.target_completion_date,
                    client_name: project.client_name,
                    client_email: project.client_email,
                    client_phone: project.client_phone,
                    client_name_2: project.client_name_2,
                    client_email_2: project.client_email_2,
                    client_phone_2: project.client_phone_2,
                    cost_plus: project.cost_plus,
                    is_template: project.is_template,
                    notes: project.notes,
                  }}
                />
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
              {isStaff && <SyncDashboardButton projectId={project.id} />}
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
      </div>
      <div className="flex-1">{children}</div>
    </div>
  )
}

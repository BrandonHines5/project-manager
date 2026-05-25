import Link from "next/link"
import { Plus, FolderKanban } from "lucide-react"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { requireSession } from "@/lib/auth"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { EmptyState } from "@/components/ui/empty"
import { formatCurrency, formatDate } from "@/lib/utils"
import type { Enums } from "@/lib/db/types"

export const metadata = { title: "Projects — Hines Homes" }

const STATUS_TONE: Record<Enums<"project_status">, "brand" | "muted" | "warning" | "success" | "danger" | "info"> = {
  lead: "muted",
  pre_construction: "info",
  active: "brand",
  on_hold: "warning",
  complete: "success",
  cancelled: "danger",
}

const STATUS_LABEL: Record<Enums<"project_status">, string> = {
  lead: "Lead",
  pre_construction: "Pre-construction",
  active: "Active",
  on_hold: "On hold",
  complete: "Complete",
  cancelled: "Cancelled",
}

export default async function ProjectsPage() {
  const profile = await requireSession()
  const supabase = await createSupabaseServerClient()
  const { data: projects } = await supabase
    .from("projects")
    .select("id, project_number, name, address, status, contract_price, start_date, target_completion_date, dashboard_url")
    .order("created_at", { ascending: false })

  return (
    <div className="max-w-7xl mx-auto px-4 md:px-6 py-6">
      <div className="flex items-center justify-between gap-3 mb-5">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
          <p className="text-sm text-muted">
            {projects?.length ?? 0} project{projects?.length === 1 ? "" : "s"}
          </p>
        </div>
        {profile.role === "staff" && (
          <Link href="/projects/new">
            <Button>
              <Plus className="h-4 w-4" />
              New project
            </Button>
          </Link>
        )}
      </div>

      {!projects || projects.length === 0 ? (
        <EmptyState
          icon={<FolderKanban className="h-10 w-10" />}
          title="No projects yet"
          description={
            profile.role === "staff"
              ? "Create your first project to get started."
              : "You don't have access to any projects yet."
          }
          action={
            profile.role === "staff" ? (
              <Link href="/projects/new">
                <Button>
                  <Plus className="h-4 w-4" />
                  New project
                </Button>
              </Link>
            ) : null
          }
        />
      ) : (
        <div className="bg-surface border border-border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-background/60 text-xs text-muted uppercase">
              <tr>
                <th className="text-left font-medium px-4 py-2.5">Project #</th>
                <th className="text-left font-medium px-4 py-2.5">Name</th>
                <th className="text-left font-medium px-4 py-2.5 hidden md:table-cell">Address</th>
                <th className="text-left font-medium px-4 py-2.5">Status</th>
                <th className="text-right font-medium px-4 py-2.5 hidden lg:table-cell">Contract</th>
                <th className="text-left font-medium px-4 py-2.5 hidden lg:table-cell">Target</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {projects.map((p) => (
                <tr
                  key={p.id}
                  className="hover:bg-background/60 transition-colors"
                >
                  <td className="px-4 py-3 font-mono text-xs">
                    <Link
                      href={`/projects/${p.id}/schedule`}
                      className="text-brand-600 hover:underline"
                    >
                      {p.project_number}
                    </Link>
                  </td>
                  <td className="px-4 py-3 font-medium">
                    <Link
                      href={`/projects/${p.id}/schedule`}
                      className="hover:underline"
                    >
                      {p.name}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-muted hidden md:table-cell truncate max-w-xs">
                    {p.address || "—"}
                  </td>
                  <td className="px-4 py-3">
                    <Badge tone={STATUS_TONE[p.status]}>
                      {STATUS_LABEL[p.status]}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums hidden lg:table-cell">
                    {formatCurrency(p.contract_price)}
                  </td>
                  <td className="px-4 py-3 text-muted hidden lg:table-cell">
                    {formatDate(p.target_completion_date)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

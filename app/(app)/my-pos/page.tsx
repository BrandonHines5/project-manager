import Link from "next/link"
import { redirect } from "next/navigation"
import { FileCheck2, CalendarDays, ExternalLink } from "lucide-react"
import { requireSession } from "@/lib/auth"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { createSupabaseAdminClient } from "@/lib/supabase/admin"
import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import { EmptyState } from "@/components/ui/empty"
import { formatCurrency, formatDate } from "@/lib/utils"
import type { Enums } from "@/lib/db/types"

export const metadata = { title: "Purchase orders — BuildFox" }

const STATUS_TONE: Record<
  Enums<"po_status">,
  "muted" | "warning" | "success" | "danger" | "neutral"
> = {
  draft: "muted",
  released: "warning",
  approved: "success",
  declined: "danger",
  void: "neutral",
}

const STATUS_LABEL: Record<Enums<"po_status">, string> = {
  draft: "Draft",
  released: "Awaiting your approval",
  approved: "Approved",
  declined: "Declined",
  void: "Voided",
}

export default async function MyPosPage() {
  const profile = await requireSession()
  // Trade-portal page — staff manage POs per project under /projects/….
  if (profile.role !== "trade") redirect("/projects")
  const supabase = await createSupabaseServerClient()

  // RLS (po_trade_read) scopes this to the trade's own company and hides
  // drafts. No projects join — labels come from the admin client below.
  const { data: pos, error } = await supabase
    .from("purchase_orders")
    .select(
      `id, project_id, number, custom_number, title, status, token,
       approval_deadline, flat_fee, flat_total, approved_at, work_complete,
       po_line_items ( quantity, unit_cost )`
    )
    .order("created_at", { ascending: false })
  if (error) throw new Error(error.message)

  const projectIds = [...new Set((pos ?? []).map((p) => p.project_id))]
  const projectById = new Map<string, { name: string; project_number: string }>()
  if (projectIds.length) {
    const admin = createSupabaseAdminClient()
    if (admin) {
      const { data: projects } = await admin
        .from("projects")
        .select("id, name, project_number")
        .in("id", projectIds)
      for (const p of projects ?? []) {
        projectById.set(p.id, { name: p.name, project_number: p.project_number })
      }
    }
  }

  const rows = (pos ?? []).map((po) => {
    const lines = (po.po_line_items ?? []) as { quantity: number; unit_cost: number }[]
    const total = po.flat_fee
      ? po.flat_total ?? 0
      : lines.reduce((sum, li) => sum + li.quantity * li.unit_cost, 0)
    return { ...po, total }
  })

  const awaiting = rows.filter((r) => r.status === "released").length

  return (
    <div className="max-w-3xl mx-auto px-4 md:px-6 py-6">
      <div className="mb-5">
        <h1 className="text-2xl font-semibold">Purchase orders</h1>
        <p className="text-sm text-muted mt-1">
          Purchase orders issued to your company.
          {awaiting > 0 && ` ${awaiting} awaiting your approval.`}
        </p>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          icon={<FileCheck2 className="h-10 w-10" />}
          title="No purchase orders yet"
          description="When Hines Homes issues your company a purchase order, it will show up here."
        />
      ) : (
        <Card>
          <ul className="divide-y divide-border">
            {rows.map((po) => {
              const project = projectById.get(po.project_id)
              const inner = (
                <div className="flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs font-mono text-muted">
                        PO-{po.number}
                        {po.custom_number ? ` (${po.custom_number})` : ""}
                      </span>
                      <span className="text-sm font-medium text-foreground">
                        {po.title}
                      </span>
                      <Badge tone={STATUS_TONE[po.status]}>
                        {STATUS_LABEL[po.status]}
                      </Badge>
                      {po.work_complete && (
                        <Badge tone="success">Work complete</Badge>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-1 text-xs text-muted">
                      {project && (
                        <>
                          <span className="font-mono">{project.project_number}</span>
                          <span className="truncate">{project.name}</span>
                        </>
                      )}
                      <span className="tabular-nums font-medium">
                        {formatCurrency(po.total)}
                      </span>
                      {po.status === "released" && po.approval_deadline && (
                        <span className="inline-flex items-center gap-1">
                          <CalendarDays className="h-3 w-3" />
                          Respond by {formatDate(po.approval_deadline)}
                        </span>
                      )}
                      {po.status === "approved" && po.approved_at && (
                        <span>Approved {formatDate(po.approved_at)}</span>
                      )}
                    </div>
                  </div>
                  {po.token && (
                    <ExternalLink className="h-4 w-4 text-muted mt-1 shrink-0" />
                  )}
                </div>
              )
              return (
                <li key={po.id} className="px-4 py-3">
                  {po.token ? (
                    <Link href={`/po/${po.token}`} className="block group">
                      {inner}
                    </Link>
                  ) : (
                    inner
                  )}
                </li>
              )
            })}
          </ul>
        </Card>
      )}
    </div>
  )
}

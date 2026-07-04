import Link from "next/link"
import { redirect } from "next/navigation"
import { Gavel, CalendarDays, ExternalLink } from "lucide-react"
import { requireSession } from "@/lib/auth"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { createSupabaseAdminClient } from "@/lib/supabase/admin"
import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import { EmptyState } from "@/components/ui/empty"
import { formatCurrency, formatDate } from "@/lib/utils"
import type { Enums } from "@/lib/db/types"

export const metadata = { title: "My bids — Hines Homes" }

const STATUS_TONE: Record<
  Enums<"bid_recipient_status">,
  "muted" | "warning" | "success" | "danger" | "info"
> = {
  invited: "warning",
  submitted: "info",
  declined: "muted",
  awarded: "success",
}

const STATUS_LABEL: Record<Enums<"bid_recipient_status">, string> = {
  invited: "Awaiting your bid",
  submitted: "Submitted",
  declined: "Declined",
  awarded: "Won",
}

export default async function MyBidsPage() {
  const profile = await requireSession()
  // Trade-portal page — staff manage bids per project under /projects/…/bids.
  if (profile.role !== "trade") redirect("/projects")
  const supabase = await createSupabaseServerClient()

  // RLS scopes this to the trade's own company (br_trade_read) and hides
  // draft packages (bp_trade_read). No projects join — trades can't read
  // projects unless they're project members; labels come from the admin
  // client below (entitlement already proven by this query).
  const { data: recipients, error } = await supabase
    .from("bid_recipients")
    .select(
      `id, status, token, flat_total, submitted_at, last_sent_at,
       bid_packages!inner ( id, project_id, number, title, due_date, status, flat_fee )`
    )
    .order("created_at", { ascending: false })
  if (error) throw new Error(error.message)

  type Row = {
    id: string
    status: Enums<"bid_recipient_status">
    token: string | null
    flat_total: number | null
    submitted_at: string | null
    package: {
      id: string
      project_id: string
      number: number
      title: string
      due_date: string | null
      status: Enums<"bid_package_status">
    }
  }
  const rows: Row[] = (recipients ?? []).map((r) => ({
    id: r.id,
    status: r.status,
    token: r.token,
    flat_total: r.flat_total,
    submitted_at: r.submitted_at,
    package: r.bid_packages as unknown as Row["package"],
  }))

  // Project labels via the admin client (see comment above).
  const projectIds = [...new Set(rows.map((r) => r.package.project_id))]
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

  const openCount = rows.filter(
    (r) => r.status === "invited" && r.package.status === "sent"
  ).length

  return (
    <div className="max-w-3xl mx-auto px-4 md:px-6 py-6">
      <div className="mb-5">
        <h1 className="text-2xl font-semibold">My bids</h1>
        <p className="text-sm text-muted mt-1">
          Bid requests sent to your company.
          {openCount > 0 && ` ${openCount} awaiting your response.`}
        </p>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          icon={<Gavel className="h-10 w-10" />}
          title="No bid requests yet"
          description="When Hines Homes invites your company to bid on work, it will show up here."
        />
      ) : (
        <Card>
          <ul className="divide-y divide-border">
            {rows.map((r) => {
              const project = projectById.get(r.package.project_id)
              const closed = r.package.status === "closed"
              const inner = (
                <div className="flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs font-mono text-muted">
                        BID-{r.package.number}
                      </span>
                      <span className="text-sm font-medium text-foreground">
                        {r.package.title}
                      </span>
                      <Badge tone={closed && r.status !== "awarded" ? "muted" : STATUS_TONE[r.status]}>
                        {closed && r.status !== "awarded" && r.status !== "declined"
                          ? "Bidding closed"
                          : STATUS_LABEL[r.status]}
                      </Badge>
                    </div>
                    <div className="flex items-center gap-3 mt-1 text-xs text-muted">
                      {project && (
                        <>
                          <span className="font-mono">{project.project_number}</span>
                          <span className="truncate">{project.name}</span>
                        </>
                      )}
                      {r.package.due_date && (
                        <span className="inline-flex items-center gap-1">
                          <CalendarDays className="h-3 w-3" />
                          Due {formatDate(r.package.due_date)}
                        </span>
                      )}
                      {r.flat_total != null && r.status !== "invited" && (
                        <span className="tabular-nums">
                          Your bid: {formatCurrency(r.flat_total)}
                        </span>
                      )}
                    </div>
                  </div>
                  {r.token && (
                    <ExternalLink className="h-4 w-4 text-muted mt-1 shrink-0" />
                  )}
                </div>
              )
              return (
                <li key={r.id} className="px-4 py-3">
                  {r.token ? (
                    <Link href={`/bid/${r.token}`} className="block group">
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

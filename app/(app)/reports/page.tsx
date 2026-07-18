import Link from "next/link"
import { AlertTriangle, GitBranch, FilePen } from "lucide-react"
import { requireStaff } from "@/lib/auth"
import { Card, CardBody } from "@/components/ui/card"

export const metadata = { title: "Reports — BuildFox" }

const REPORTS = [
  {
    href: "/reports/delays",
    title: "Delay Report",
    description:
      "All logged delays across projects, summarised by reason category.",
    icon: AlertTriangle,
    ready: true,
  },
  {
    href: "/reports/variance",
    title: "Schedule Variance",
    description:
      "Baseline vs. current dates per work item, with days variance.",
    icon: GitBranch,
    ready: true,
  },
  {
    href: "#",
    title: "Decision Summary",
    description: "Approved / pending decisions with cost impact totals.",
    icon: FilePen,
    ready: false,
  },
]

export default async function ReportsLandingPage() {
  await requireStaff()
  return (
    <div className="max-w-5xl mx-auto px-4 md:px-6 py-6">
      <h1 className="text-2xl font-semibold tracking-tight mb-1">Reports</h1>
      <p className="text-sm text-muted mb-6">
        Roll-up views across all projects.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {REPORTS.map((r) => {
          const Icon = r.icon
          const inner = (
            <Card
              className={
                r.ready
                  ? "hover:border-brand-500 cursor-pointer transition-colors h-full"
                  : "opacity-60 cursor-not-allowed h-full"
              }
            >
              <CardBody className="flex items-start gap-3">
                <div className="rounded-md bg-brand-100 text-brand-700 p-2">
                  <Icon className="h-4 w-4" />
                </div>
                <div>
                  <div className="font-semibold text-foreground">
                    {r.title}
                    {!r.ready && (
                      <span className="ml-2 text-xs text-muted">soon</span>
                    )}
                  </div>
                  <p className="text-xs text-muted mt-0.5">{r.description}</p>
                </div>
              </CardBody>
            </Card>
          )
          return r.ready ? (
            <Link key={r.href} href={r.href}>
              {inner}
            </Link>
          ) : (
            <div key={r.title}>{inner}</div>
          )
        })}
      </div>
    </div>
  )
}

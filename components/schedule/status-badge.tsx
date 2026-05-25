import { Badge } from "@/components/ui/badge"
import type { Enums } from "@/lib/db/types"

export function StatusBadge({ status }: { status: Enums<"schedule_item_status"> }) {
  const map = {
    not_started: { label: "Not started", tone: "muted" as const },
    in_progress: { label: "In progress", tone: "info" as const },
    complete: { label: "Complete", tone: "success" as const },
    delayed: { label: "Delayed", tone: "danger" as const },
  }
  const { label, tone } = map[status]
  return <Badge tone={tone}>{label}</Badge>
}

import { FolderKanban } from "lucide-react"
import { EmptyState } from "@/components/ui/empty"

// Shown when the /all/* scope resolves to zero jobs — either the ?ids=
// selection points at jobs the viewer can't see, or there are no open jobs.
export function EmptyScope({ explicit }: { explicit: boolean }) {
  return (
    <EmptyState
      icon={<FolderKanban className="h-10 w-10" />}
      title={explicit ? "No matching jobs" : "No open jobs"}
      description={
        explicit
          ? "None of the selected jobs are visible to you anymore. Clear the selection in the jobs list and try again."
          : "There are no open jobs to aggregate yet."
      }
    />
  )
}

import { CheckSquare } from "lucide-react"
import { EmptyState } from "@/components/ui/empty"

export function EmptySelection({ entity }: { entity: string }) {
  return (
    <EmptyState
      icon={<CheckSquare className="h-10 w-10" />}
      title={`No projects selected`}
      description={`Tick projects in the left sidebar, then come back here to see ${entity} across all of them.`}
    />
  )
}

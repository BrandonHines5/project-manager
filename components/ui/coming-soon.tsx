import { Construction } from "lucide-react"
import { EmptyState } from "./empty"

export function ComingSoon({
  feature,
  description,
}: {
  feature: string
  description?: string
}) {
  return (
    <div className="max-w-7xl mx-auto px-4 md:px-6 py-6">
      <EmptyState
        icon={<Construction className="h-10 w-10" />}
        title={`${feature} — coming soon`}
        description={description ?? "This module is on the roadmap."}
      />
    </div>
  )
}

"use client"

import { useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { RefreshCw } from "lucide-react"
import { syncProjectFromDashboard } from "@/app/actions/projects"

/**
 * "Sync from dashboard" — re-pulls the project manager and the canonical
 * dashboard link for an existing project. Lives in the project header so staff
 * can backfill jobs created before this data was captured (or whose dashboard
 * link was built from the project number and 500s the dashboard).
 */
export function SyncDashboardButton({ projectId }: { projectId: string }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  function sync() {
    startTransition(async () => {
      try {
        const res = await syncProjectFromDashboard({ project_id: projectId })
        if (res.ok) {
          toast.success(
            res.project_manager
              ? `Synced · PM: ${res.project_manager}`
              : "Synced from dashboard"
          )
          router.refresh()
        } else {
          toast.error(res.error)
        }
      } catch {
        toast.error("Couldn't sync from the dashboard. Try again.")
      }
    })
  }

  return (
    <button
      type="button"
      onClick={sync}
      disabled={pending}
      className="inline-flex items-center gap-1 text-muted hover:text-foreground disabled:opacity-50 cursor-pointer"
      title="Re-pull the project manager and dashboard link from the dashboard"
    >
      <RefreshCw className={pending ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />
      {pending ? "Syncing…" : "Sync"}
    </button>
  )
}

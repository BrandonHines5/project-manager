"use client"

import { useTransition } from "react"
import { useRouter } from "next/navigation"
import { BellOff, X } from "lucide-react"
import { toast } from "sonner"
import { Card, CardBody } from "@/components/ui/card"
import {
  SearchableSelect,
  type SearchableOption,
} from "@/components/ui/searchable-select"
import { setProjectNotificationsMuted } from "@/app/actions/notification-mutes"

// "Muted jobs" block on Settings → Notifications. Personal: muting a job
// silences ALL of that job's notifications (bell, email, texts) for the
// signed-in user only. The same mute is toggled by the bell on the job
// header.
export function MutedJobsSection({
  muted,
  options,
}: {
  muted: { project_id: string; label: string }[]
  options: SearchableOption[]
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  function setMuted(projectId: string, next: boolean) {
    startTransition(async () => {
      try {
        await setProjectNotificationsMuted({
          project_id: projectId,
          muted: next,
        })
        router.refresh()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not update")
      }
    })
  }

  return (
    <Card className="mt-6">
      <div className="px-4 py-3 border-b border-border">
        <h2 className="text-sm font-semibold inline-flex items-center gap-1.5">
          <BellOff className="h-4 w-4 text-muted" />
          Muted jobs
        </h2>
        <p className="text-xs text-muted mt-0.5">
          Turn off all notifications from specific jobs — just for you, the
          rest of the team is unaffected. You can also use the bell on a
          job&apos;s header.
        </p>
      </div>
      <CardBody className="space-y-3">
        {muted.length > 0 ? (
          <ul className="divide-y divide-border rounded-md border border-border">
            {muted.map((m) => (
              <li
                key={m.project_id}
                className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
              >
                <span className="min-w-0 truncate">{m.label}</span>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => setMuted(m.project_id, false)}
                  className="inline-flex items-center gap-1 text-xs text-muted hover:text-foreground cursor-pointer disabled:opacity-50"
                  title="Turn notifications for this job back on"
                >
                  <X className="h-3.5 w-3.5" /> Unmute
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">
            No muted jobs — you get notifications from every job you&apos;re
            on.
          </p>
        )}
        <div className="max-w-md">
          <SearchableSelect
            value=""
            onChange={(v) => {
              if (v) setMuted(v, true)
            }}
            options={options}
            placeholder="Mute a job…"
            searchPlaceholder="Type to find a job…"
            disabled={pending}
            ariaLabel="Mute a job"
          />
        </div>
      </CardBody>
    </Card>
  )
}

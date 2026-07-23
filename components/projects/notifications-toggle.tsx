"use client"

import { useState, useTransition } from "react"
import { Bell, BellOff } from "lucide-react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import { setProjectNotificationsMuted } from "@/app/actions/notification-mutes"

// Per-job notification bell in the project header — personal to the
// signed-in user (staff, client, or sub alike). Muting silences every
// notification about this job (bell, email, texts) for you only; the same
// mute is managed under Settings → Notifications.
export function ProjectNotificationsToggle({
  projectId,
  initialMuted,
}: {
  projectId: string
  initialMuted: boolean
}) {
  const [muted, setMuted] = useState(initialMuted)
  const [pending, startTransition] = useTransition()

  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => {
        const next = !muted
        setMuted(next)
        startTransition(async () => {
          try {
            await setProjectNotificationsMuted({
              project_id: projectId,
              muted: next,
            })
            toast.success(
              next
                ? "Notifications off for this job (just for you)"
                : "Notifications back on for this job"
            )
          } catch (e) {
            setMuted(!next)
            toast.error(
              e instanceof Error ? e.message : "Could not update notifications"
            )
          }
        })
      }}
      className={cn(
        "inline-flex items-center gap-1 cursor-pointer disabled:opacity-50",
        muted
          ? "text-danger hover:text-danger/80"
          : "text-muted hover:text-foreground"
      )}
      title={
        muted
          ? "Notifications for this job are off for you — click to turn back on"
          : "Turn off this job's notifications (just for you)"
      }
    >
      {muted ? <BellOff className="h-4 w-4" /> : <Bell className="h-4 w-4" />}
      {muted ? "Muted" : "Notifications"}
    </button>
  )
}

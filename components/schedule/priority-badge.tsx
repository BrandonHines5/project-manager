import { Flag } from "lucide-react"
import { cn } from "@/lib/utils"
import type { Enums } from "@/lib/db/types"

// Low/medium priorities intentionally render nothing — the flag is reserved
// for high-priority to-dos so it reads as an alert, not decoration. Priority
// still drives the To-dos view filter/sort and stays editable in the dialog.
export function PriorityBadge({
  priority,
  size = "sm",
}: {
  priority: Enums<"todo_priority">
  size?: "sm" | "xs"
}) {
  if (priority !== "high") return null
  const iconDim = size === "xs" ? "h-2.5 w-2.5" : "h-3 w-3"
  const txt = size === "xs" ? "text-[10px]" : "text-[11px]"
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 font-medium capitalize",
        txt,
        "bg-red-100 text-red-700"
      )}
      title="high priority"
    >
      <Flag className={iconDim} />
      {priority}
    </span>
  )
}

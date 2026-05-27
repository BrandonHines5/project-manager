import { Flag } from "lucide-react"
import { cn } from "@/lib/utils"
import type { Enums } from "@/lib/db/types"

const STYLE: Record<Enums<"todo_priority">, string> = {
  low: "bg-zinc-100 text-zinc-700",
  medium: "bg-amber-100 text-amber-800",
  high: "bg-red-100 text-red-700",
}

export function PriorityBadge({
  priority,
  size = "sm",
}: {
  priority: Enums<"todo_priority">
  size?: "sm" | "xs"
}) {
  const iconDim = size === "xs" ? "h-2.5 w-2.5" : "h-3 w-3"
  const txt = size === "xs" ? "text-[10px]" : "text-[11px]"
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 font-medium capitalize",
        txt,
        STYLE[priority]
      )}
      title={`${priority} priority`}
    >
      <Flag className={iconDim} />
      {priority}
    </span>
  )
}

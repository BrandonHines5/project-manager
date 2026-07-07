import { cn } from "@/lib/utils"
import { AvatarStack } from "@/components/ui/avatar"

// Avatar bubble(s) plus the assignees' full names (person, company, or
// resolved role label). Names are hidden on phone widths where the row
// doesn't have room for them. Shared by the schedule List and To-dos views
// so the label treatment can't drift between them.
export function AssigneeChips({
  names,
  size,
  title,
  className,
}: {
  names: string[]
  size: "xs" | "sm"
  // Overrides the default hover title (the joined names) — e.g. to note
  // that the assignees are inherited from the parent work item.
  title?: string
  className?: string
}) {
  if (names.length === 0) return null
  const joined = names.join(", ")
  return (
    <div
      className={cn("flex items-center gap-1.5 min-w-0", className)}
      title={title ?? joined}
    >
      <AvatarStack names={names} size={size} />
      <span
        className={cn(
          "hidden sm:inline text-muted truncate max-w-48 text-right",
          size === "xs" ? "text-[11px]" : "text-xs"
        )}
      >
        {joined}
      </span>
    </div>
  )
}

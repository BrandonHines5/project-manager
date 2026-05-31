import { cn } from "@/lib/utils"

/**
 * Pulsing placeholder for content that's still loading. Use in place of the
 * empty-then-populate flicker on the projects list, schedule, decisions,
 * and files screens. Width/height are caller-controlled; this is just the
 * surface + animation.
 */
export function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "animate-pulse rounded-md bg-border/60",
        className
      )}
      {...props}
    />
  )
}

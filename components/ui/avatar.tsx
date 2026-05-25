import { cn } from "@/lib/utils"

const colors = [
  "bg-blue-500",
  "bg-emerald-500",
  "bg-amber-500",
  "bg-purple-500",
  "bg-pink-500",
  "bg-sky-500",
  "bg-rose-500",
  "bg-indigo-500",
  "bg-teal-500",
]

function colorFor(seed: string) {
  let h = 0
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) >>> 0
  }
  return colors[h % colors.length]
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase() ?? "")
    .join("")
}

export function Avatar({
  name,
  size = "md",
  className,
  title,
}: {
  name: string
  size?: "xs" | "sm" | "md" | "lg"
  className?: string
  title?: string
}) {
  const sizeClass = {
    xs: "h-6 w-6 text-[10px]",
    sm: "h-7 w-7 text-xs",
    md: "h-8 w-8 text-xs",
    lg: "h-10 w-10 text-sm",
  }[size]
  const safeName = name || "?"
  return (
    <span
      title={title ?? safeName}
      className={cn(
        "inline-flex items-center justify-center rounded-full text-white font-semibold ring-2 ring-surface",
        colorFor(safeName),
        sizeClass,
        className
      )}
    >
      {initials(safeName) || "?"}
    </span>
  )
}

export function AvatarStack({
  names,
  max = 3,
  size = "md",
  className,
}: {
  names: string[]
  max?: number
  size?: "xs" | "sm" | "md" | "lg"
  className?: string
}) {
  const shown = names.slice(0, max)
  const overflow = names.length - shown.length
  return (
    <div className={cn("flex -space-x-1.5", className)}>
      {shown.map((n, i) => (
        <Avatar key={`${n}-${i}`} name={n} size={size} />
      ))}
      {overflow > 0 && (
        <span
          className={cn(
            "inline-flex items-center justify-center rounded-full bg-zinc-200 text-foreground font-semibold ring-2 ring-surface",
            size === "xs" && "h-6 w-6 text-[10px]",
            size === "sm" && "h-7 w-7 text-xs",
            size === "md" && "h-8 w-8 text-xs",
            size === "lg" && "h-10 w-10 text-sm",
          )}
        >
          +{overflow}
        </span>
      )}
    </div>
  )
}

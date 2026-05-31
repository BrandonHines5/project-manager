import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
  {
    variants: {
      tone: {
        neutral: "bg-background text-foreground border border-border-strong",
        brand: "bg-brand-100 text-brand-700",
        success: "bg-green-100 text-green-800",
        warning: "bg-amber-100 text-amber-900",
        danger: "bg-red-100 text-red-800",
        info: "bg-blue-100 text-blue-900",
        muted: "bg-zinc-100 text-zinc-700",
      },
    },
    defaultVariants: { tone: "neutral" },
  }
)

export type BadgeProps = React.HTMLAttributes<HTMLSpanElement> &
  VariantProps<typeof badgeVariants>

export function Badge({ className, tone, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />
}

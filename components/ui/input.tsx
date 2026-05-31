import * as React from "react"
import { cn } from "@/lib/utils"

export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }
>(function Input({ className, type = "text", invalid, ...props }, ref) {
  return (
    <input
      ref={ref}
      type={type}
      aria-invalid={invalid || undefined}
      className={cn(
        "flex h-9 w-full rounded-md border border-border-strong bg-surface px-3 py-1 text-sm placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40 disabled:opacity-50",
        invalid &&
          "border-danger focus-visible:ring-danger/40",
        className
      )}
      {...props}
    />
  )
})

export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }
>(function Textarea({ className, invalid, ...props }, ref) {
  return (
    <textarea
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cn(
        "flex min-h-[72px] w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-sm placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40 disabled:opacity-50",
        invalid && "border-danger focus-visible:ring-danger/40",
        className
      )}
      {...props}
    />
  )
})

export const Select = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }
>(function Select({ className, children, invalid, ...props }, ref) {
  return (
    <select
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cn(
        "flex h-9 w-full rounded-md border border-border-strong bg-surface px-3 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40 disabled:opacity-50",
        invalid && "border-danger focus-visible:ring-danger/40",
        className
      )}
      {...props}
    >
      {children}
    </select>
  )
})

export function Label({
  className,
  ...props
}: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label
      className={cn("text-xs font-medium text-muted uppercase tracking-wide", className)}
      {...props}
    />
  )
}

/**
 * Field: label + control + (hint xor error).
 *
 * When `error` is set, the hint is hidden so the error replaces it (same
 * physical slot — no layout shift), and the error string is exposed via
 * `role="alert"` so screen readers announce it on submit. Pass `htmlFor` to
 * link the label to a specific input id; when omitted the wrapping label
 * still scopes clicks to the first descendant control.
 */
export function Field({
  label,
  children,
  hint,
  error,
  htmlFor,
  className,
}: {
  label?: string
  children: React.ReactNode
  hint?: string
  error?: string | null
  htmlFor?: string
  className?: string
}) {
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      {label && <Label htmlFor={htmlFor}>{label}</Label>}
      {children}
      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-muted">{hint}</p>
      ) : null}
    </div>
  )
}

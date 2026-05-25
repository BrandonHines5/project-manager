"use client"

import * as React from "react"
import { createPortal } from "react-dom"
import { X } from "lucide-react"
import { cn } from "@/lib/utils"

type DialogContextValue = {
  open: boolean
  setOpen: (v: boolean) => void
}

const DialogContext = React.createContext<DialogContextValue | null>(null)

function useMounted() {
  return React.useSyncExternalStore(
    () => () => {},
    () => true,
    () => false
  )
}

export function Dialog({
  open,
  onOpenChange,
  children,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  children: React.ReactNode
}) {
  return (
    <DialogContext.Provider value={{ open, setOpen: onOpenChange }}>
      {children}
    </DialogContext.Provider>
  )
}

export function DialogContent({
  className,
  children,
  size = "md",
  side,
}: {
  className?: string
  children: React.ReactNode
  size?: "sm" | "md" | "lg" | "xl"
  side?: "right"
}) {
  const ctx = React.useContext(DialogContext)
  const mounted = useMounted()

  React.useEffect(() => {
    if (!ctx?.open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") ctx?.setOpen(false)
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [ctx])

  if (!mounted || !ctx?.open) return null

  const sizeClass = {
    sm: "max-w-md",
    md: "max-w-lg",
    lg: "max-w-2xl",
    xl: "max-w-4xl",
  }[size]

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-stretch sm:items-center justify-end sm:justify-center bg-black/40"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) ctx.setOpen(false)
      }}
    >
      <div
        className={cn(
          "bg-surface w-full shadow-2xl border-l border-border sm:border sm:rounded-lg",
          side === "right"
            ? "h-full max-w-2xl sm:max-w-3xl sm:h-[90vh] sm:rounded-l-lg sm:rounded-r-lg"
            : `h-full sm:h-auto sm:max-h-[90vh] sm:my-auto ${sizeClass}`,
          "flex flex-col overflow-hidden",
          className
        )}
      >
        <button
          className="absolute top-3 right-3 z-10 rounded-md p-1.5 text-muted hover:bg-background hover:text-foreground cursor-pointer"
          onClick={() => ctx.setOpen(false)}
          aria-label="Close"
          type="button"
        >
          <X className="h-4 w-4" />
        </button>
        {children}
      </div>
    </div>,
    document.body
  )
}

export function DialogHeader({
  className,
  children,
}: {
  className?: string
  children: React.ReactNode
}) {
  return (
    <div
      className={cn(
        "px-6 py-4 border-b border-border flex items-start justify-between gap-4",
        className
      )}
    >
      {children}
    </div>
  )
}

export function DialogTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="text-lg font-semibold text-foreground">{children}</h2>
}

export function DialogDescription({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-muted mt-0.5">{children}</p>
}

export function DialogBody({
  className,
  children,
}: {
  className?: string
  children: React.ReactNode
}) {
  return (
    <div className={cn("px-6 py-5 overflow-y-auto flex-1", className)}>
      {children}
    </div>
  )
}

export function DialogFooter({
  className,
  children,
}: {
  className?: string
  children: React.ReactNode
}) {
  return (
    <div
      className={cn(
        "px-6 py-3 border-t border-border flex items-center justify-end gap-2 bg-background/60",
        className
      )}
    >
      {children}
    </div>
  )
}

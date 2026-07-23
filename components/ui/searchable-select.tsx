"use client"

import * as React from "react"
import { ChevronDown, Search, Check, X } from "lucide-react"
import { cn } from "@/lib/utils"

export type SearchableOption = {
  value: string
  label: string
  // Optional secondary text rendered dimmed after the label ("Team",
  // "(company)", a trade category…). Searched along with the label.
  hint?: string
}

/**
 * Type-to-filter replacement for `Select` over dynamic entity lists
 * (companies, people, roles, cost codes…). Same closed-state look as the
 * native Select; opens a panel with a search box and the filtered options.
 *
 * Value semantics match the codebase's native-select convention: `""` means
 * nothing selected and `onChange("")` is the clear. Keep tiny fixed enums
 * (status, priority) on the plain Select — this is for lists that grow.
 */
export function SearchableSelect({
  value,
  onChange,
  options,
  placeholder = "— Select —",
  searchPlaceholder = "Type to search…",
  clearable = true,
  disabled,
  invalid,
  id,
  ariaLabel,
  className,
}: {
  value: string
  onChange: (value: string) => void
  options: SearchableOption[]
  placeholder?: string
  searchPlaceholder?: string
  // Render a clear affordance when something is selected (maps to
  // onChange("")). Turn off for required pickers with no empty state.
  clearable?: boolean
  disabled?: boolean
  invalid?: boolean
  id?: string
  ariaLabel?: string
  className?: string
}) {
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState("")
  const [activeIdx, setActiveIdx] = React.useState(0)
  const wrapRef = React.useRef<HTMLDivElement | null>(null)
  const panelRef = React.useRef<HTMLDivElement | null>(null)
  const searchRef = React.useRef<HTMLInputElement | null>(null)
  const listRef = React.useRef<HTMLUListElement | null>(null)

  const selected = options.find((o) => o.value === value) ?? null

  const q = query.trim().toLowerCase()
  const filtered = q
    ? options.filter(
        (o) =>
          o.label.toLowerCase().includes(q) ||
          (o.hint?.toLowerCase().includes(q) ?? false)
      )
    : options

  // Close on click/tap outside, and on Escape. The Escape listener runs in
  // the capture phase and stops propagation so a surrounding Dialog's
  // document-level Escape handler doesn't also close the whole drawer.
  React.useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent | TouchEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return
      e.stopPropagation()
      setOpen(false)
    }
    document.addEventListener("mousedown", onDown)
    document.addEventListener("touchstart", onDown)
    document.addEventListener("keydown", onKey, true)
    return () => {
      document.removeEventListener("mousedown", onDown)
      document.removeEventListener("touchstart", onDown)
      document.removeEventListener("keydown", onKey, true)
    }
  }, [open])

  // Focus the search box on open and make sure the panel isn't clipped by a
  // scrolling dialog body. (The filter itself is reset in the trigger's
  // onClick, not here — setting state from an effect trips the lint rule.)
  React.useEffect(() => {
    if (!open) return
    const t = requestAnimationFrame(() => {
      searchRef.current?.focus()
      panelRef.current?.scrollIntoView({ block: "nearest" })
    })
    return () => cancelAnimationFrame(t)
  }, [open])

  function choose(v: string) {
    onChange(v)
    setOpen(false)
  }

  function onSearchKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault()
      setActiveIdx((i) => Math.min(i + 1, filtered.length - 1))
      scrollActiveIntoView(1)
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      setActiveIdx((i) => Math.max(i - 1, 0))
      scrollActiveIntoView(-1)
    } else if (e.key === "Enter") {
      e.preventDefault()
      const opt = filtered[activeIdx]
      if (opt) choose(opt.value)
    } else if (e.key === "Tab") {
      setOpen(false)
    }
  }

  function scrollActiveIntoView(dir: 1 | -1) {
    // Runs before state applies; nudge the neighbor into view instead of
    // re-deriving the exact index — close enough for a keyboard walk.
    const items = listRef.current?.children
    if (!items) return
    const next = items[activeIdx + dir] as HTMLElement | undefined
    next?.scrollIntoView({ block: "nearest" })
  }

  return (
    <div ref={wrapRef} className={cn("relative", className)}>
      <button
        type="button"
        id={id}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => {
          if (!open) {
            // Fresh filter every open.
            setQuery("")
            setActiveIdx(0)
          }
          setOpen(!open)
        }}
        className={cn(
          "flex h-9 w-full items-center gap-2 rounded-md border border-border-strong bg-surface px-3 py-1 text-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40 disabled:opacity-50 cursor-pointer",
          invalid && "border-danger focus-visible:ring-danger/40"
        )}
      >
        <span className={cn("flex-1 truncate", !selected && "text-muted")}>
          {selected ? (
            <>
              {selected.label}
              {selected.hint && (
                <span className="text-muted"> · {selected.hint}</span>
              )}
            </>
          ) : (
            placeholder
          )}
        </span>
        {clearable && selected && !disabled && (
          <span
            role="button"
            tabIndex={-1}
            aria-label="Clear selection"
            onClick={(e) => {
              e.stopPropagation()
              onChange("")
              setOpen(false)
            }}
            className="shrink-0 rounded p-0.5 text-muted hover:text-foreground cursor-pointer"
          >
            <X className="h-3.5 w-3.5" />
          </span>
        )}
        <ChevronDown className="h-4 w-4 shrink-0 text-muted" />
      </button>

      {open && (
        <div
          ref={panelRef}
          className="absolute left-0 right-0 z-30 mt-1 min-w-[240px] rounded-md border border-border bg-surface shadow-lg"
        >
          <div className="relative border-b border-border p-1.5">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setActiveIdx(0)
              }}
              onKeyDown={onSearchKeyDown}
              placeholder={searchPlaceholder}
              aria-label="Search options"
              className="h-8 w-full rounded border border-transparent bg-background/60 pl-7 pr-2 text-sm placeholder:text-muted focus:outline-none"
            />
          </div>
          <ul
            ref={listRef}
            role="listbox"
            className="max-h-60 overflow-y-auto py-1"
          >
            {filtered.length === 0 && (
              <li className="px-3 py-2 text-sm text-muted">No matches.</li>
            )}
            {filtered.map((o, i) => {
              const isSelected = o.value === value
              return (
                <li key={o.value} role="option" aria-selected={isSelected}>
                  <button
                    type="button"
                    onClick={() => choose(o.value)}
                    onMouseEnter={() => setActiveIdx(i)}
                    className={cn(
                      "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm cursor-pointer",
                      i === activeIdx && "bg-background/80",
                      isSelected && "font-medium"
                    )}
                  >
                    <span className="flex-1 truncate">
                      {o.label}
                      {o.hint && (
                        <span className="text-muted font-normal">
                          {" "}
                          · {o.hint}
                        </span>
                      )}
                    </span>
                    {isSelected && (
                      <Check className="h-3.5 w-3.5 shrink-0 text-brand-600" />
                    )}
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </div>
  )
}

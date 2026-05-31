"use client"

import { useState, useRef, useId } from "react"
import { X, Plus } from "lucide-react"
import { cn } from "@/lib/utils"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/input"

/**
 * Multi-tag input for a company's trades. Free-text but normalized: a tag
 * is lower-cased + trimmed before being added, duplicates are dropped, and
 * each chip can be removed with a single click. Submitting with the Enter
 * key on the input is intentional (so power users can rip through "framing,
 * roofing, siding, …" without leaving the keyboard).
 *
 * `suggestions` is the pool of trades already used by other companies. We
 * show them as click-to-add chips below the input so the staff person
 * picks "framing" instead of accidentally creating "framers" as a new tag.
 */
export function TradeChipsEditor({
  value,
  onChange,
  suggestions = [],
  label = "Trades",
  placeholder = "Add a trade (e.g. framing)",
}: {
  value: string[]
  onChange: (next: string[]) => void
  suggestions?: string[]
  label?: string
  placeholder?: string
}) {
  const [draft, setDraft] = useState("")
  const inputRef = useRef<HTMLInputElement | null>(null)
  const inputId = useId()

  const normalized = (s: string) => s.trim().toLowerCase()

  function commit() {
    const v = normalized(draft)
    if (!v) return
    if (v.length > 60) return
    if (value.includes(v)) {
      setDraft("")
      return
    }
    onChange([...value, v].sort())
    setDraft("")
  }

  function remove(tag: string) {
    onChange(value.filter((t) => t !== tag))
  }

  // Suggestions = the global pool minus what's already on this company. Cap
  // at 12 so the row stays manageable on mobile.
  const filteredSuggestions = suggestions
    .filter((s) => !value.includes(s))
    .slice(0, 12)

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={inputId}>{label}</Label>
      <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-border-strong bg-surface px-2 py-1.5 min-h-9">
        {value.map((t) => (
          <span
            key={t}
            className="inline-flex items-center gap-1 rounded-full bg-brand-100 text-brand-700 text-xs px-2 py-0.5"
          >
            {t}
            <button
              type="button"
              onClick={() => remove(t)}
              aria-label={`Remove ${t}`}
              className="text-brand-700/70 hover:text-brand-700 cursor-pointer"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          id={inputId}
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault()
              commit()
            }
            if (
              e.key === "Backspace" &&
              draft === "" &&
              value.length > 0
            ) {
              // Quick remove of last chip when the input is empty.
              remove(value[value.length - 1])
            }
          }}
          onBlur={() => {
            if (draft.trim() !== "") commit()
          }}
          placeholder={value.length === 0 ? placeholder : ""}
          className="flex-1 min-w-[8rem] bg-transparent text-sm outline-none placeholder:text-muted"
        />
      </div>
      {filteredSuggestions.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          <span className="text-[11px] text-muted self-center mr-1">
            Suggestions:
          </span>
          {filteredSuggestions.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => {
                onChange([...value, s].sort())
                inputRef.current?.focus()
              }}
              className={cn(
                "inline-flex items-center gap-1 rounded-full border border-border-strong",
                "text-[11px] px-2 py-0.5 text-muted hover:bg-background hover:text-foreground cursor-pointer"
              )}
            >
              <Plus className="h-2.5 w-2.5" />
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

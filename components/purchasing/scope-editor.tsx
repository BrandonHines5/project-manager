"use client"

import { useRef } from "react"
import { List, ListOrdered, Bold } from "lucide-react"
import { Textarea } from "@/components/ui/input"

// Scope textarea with a lightweight formatting toolbar. The value stays
// plain text (same DB column, same server actions) using markers the
// ScopeText renderer understands: "- " bullets, "1. " numbered items and
// **bold**. Enter continues a list on the next line; Enter on an empty
// list item exits the list.
export function ScopeEditor({
  value,
  onChange,
  rows = 5,
  placeholder,
  disabled,
}: {
  value: string
  onChange: (v: string) => void
  rows?: number
  placeholder?: string
  disabled?: boolean
}) {
  const ref = useRef<HTMLTextAreaElement>(null)

  // Apply an edit and restore focus + selection so toolbar clicks don't
  // dump the caret at the end of the field.
  function apply(next: string, selStart: number, selEnd: number) {
    onChange(next)
    requestAnimationFrame(() => {
      const el = ref.current
      if (!el) return
      el.focus()
      el.setSelectionRange(selStart, selEnd)
    })
  }

  // Expand the current selection to whole lines and toggle a list prefix on
  // each: if every selected line already has one, strip it; otherwise add.
  function toggleList(kind: "ul" | "ol") {
    const el = ref.current
    if (!el) return
    const { selectionStart, selectionEnd } = el
    const lineStart = value.lastIndexOf("\n", selectionStart - 1) + 1
    const lineEndRaw = value.indexOf("\n", selectionEnd)
    const lineEnd = lineEndRaw === -1 ? value.length : lineEndRaw
    const before = value.slice(0, lineStart)
    const block = value.slice(lineStart, lineEnd)
    const after = value.slice(lineEnd)

    const lines = block.split("\n")
    const re = kind === "ul" ? /^\s*[-*]\s+/ : /^\s*\d+[.)]\s+/
    const allMarked = lines.every((l) => l.trim() === "" || re.test(l))
    let n = 0
    const next = lines
      .map((l) => {
        if (l.trim() === "") return l
        // Strip either marker first so toggling between kinds swaps cleanly.
        const bare = l.replace(/^\s*[-*]\s+/, "").replace(/^\s*\d+[.)]\s+/, "")
        if (allMarked) return bare
        n += 1
        return kind === "ul" ? `- ${bare}` : `${n}. ${bare}`
      })
      .join("\n")

    const full = before + next + after
    apply(full, lineStart, lineStart + next.length)
  }

  function toggleBold() {
    const el = ref.current
    if (!el) return
    const { selectionStart, selectionEnd } = el
    const sel = value.slice(selectionStart, selectionEnd)
    if (!sel) return
    const isBold = sel.startsWith("**") && sel.endsWith("**") && sel.length > 4
    const next = isBold ? sel.slice(2, -2) : `**${sel}**`
    const full =
      value.slice(0, selectionStart) + next + value.slice(selectionEnd)
    apply(full, selectionStart, selectionStart + next.length)
  }

  // Enter inside a list continues it ("- " / "4. " on the new line); Enter
  // on an empty item removes the marker and leaves the list.
  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key !== "Enter" || e.shiftKey) return
    const el = e.currentTarget
    const { selectionStart, selectionEnd } = el
    if (selectionStart !== selectionEnd) return
    const lineStart = value.lastIndexOf("\n", selectionStart - 1) + 1
    const line = value.slice(lineStart, selectionStart)
    const bullet = /^(\s*)([-*])\s+(.*)$/.exec(line)
    const numbered = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line)
    if (!bullet && !numbered) return
    e.preventDefault()
    const content = (bullet ?? numbered)![3]
    if (content.trim() === "") {
      // Empty item — exit the list.
      const full =
        value.slice(0, lineStart) + "\n" + value.slice(selectionStart)
      apply(full, lineStart + 1, lineStart + 1)
      return
    }
    const marker = bullet
      ? `${bullet[1]}- `
      : `${numbered![1]}${Number(numbered![2]) + 1}. `
    const insert = `\n${marker}`
    const full =
      value.slice(0, selectionStart) + insert + value.slice(selectionStart)
    const caret = selectionStart + insert.length
    apply(full, caret, caret)
  }

  return (
    <div>
      <div className="mb-1 flex items-center gap-1">
        <ToolbarButton
          label="Bulleted list"
          onClick={() => toggleList("ul")}
          disabled={disabled}
        >
          <List className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton
          label="Numbered list"
          onClick={() => toggleList("ol")}
          disabled={disabled}
        >
          <ListOrdered className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton
          label="Bold (select text first)"
          onClick={toggleBold}
          disabled={disabled}
        >
          <Bold className="h-3.5 w-3.5" />
        </ToolbarButton>
        <span className="ml-1 text-[10px] text-muted">
          Formatting shows on the sub&apos;s page
        </span>
      </div>
      <Textarea
        ref={ref}
        rows={rows}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        disabled={disabled}
      />
    </div>
  )
}

function ToolbarButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className="inline-flex h-7 w-7 items-center justify-center rounded border border-border text-muted hover:border-border-strong hover:text-foreground cursor-pointer disabled:opacity-50"
    >
      {children}
    </button>
  )
}

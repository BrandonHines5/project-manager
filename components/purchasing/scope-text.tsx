import { Fragment } from "react"
import { cn } from "@/lib/utils"

// Server-safe renderer for the bid/PO Scope field's lightweight formatting.
// The scope stays PLAIN TEXT in the DB; this turns the editor's markers into
// real elements at display time:
//   "- " or "* " line prefix   → bulleted list item
//   "1. " style line prefix    → numbered list item
//   **text**                   → bold
// Everything else renders as pre-wrap paragraphs, so scopes written before
// the toolbar existed look exactly like they always did. Built from React
// elements — no HTML injection surface on the public token pages.

type Block =
  | { type: "ul" | "ol"; items: string[] }
  | { type: "p"; text: string }

function parseBlocks(text: string): Block[] {
  const blocks: Block[] = []
  let para: string[] = []
  const flushPara = () => {
    if (para.length > 0) {
      blocks.push({ type: "p", text: para.join("\n") })
      para = []
    }
  }
  for (const line of text.split("\n")) {
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line)
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    if (bullet || numbered) {
      flushPara()
      const type = bullet ? "ul" : "ol"
      const item = (bullet ?? numbered)![1]
      const last = blocks[blocks.length - 1]
      if (last && last.type === type) last.items.push(item)
      else blocks.push({ type, items: [item] })
    } else if (line.trim() === "") {
      flushPara()
    } else {
      para.push(line)
    }
  }
  flushPara()
  return blocks
}

// **bold** → <strong>; everything else passes through verbatim.
function inline(text: string): React.ReactNode {
  const parts = text.split(/\*\*([^*]+)\*\*/g)
  if (parts.length === 1) return text
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <strong key={i} className="font-semibold">
        {part}
      </strong>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    )
  )
}

export function ScopeText({
  text,
  className,
}: {
  text: string
  className?: string
}) {
  const blocks = parseBlocks(text)
  return (
    <div className={cn("space-y-2", className)}>
      {blocks.map((b, i) =>
        b.type === "p" ? (
          <p key={i} className="whitespace-pre-wrap">
            {inline(b.text)}
          </p>
        ) : b.type === "ul" ? (
          <ul key={i} className="list-disc pl-5 space-y-0.5">
            {b.items.map((item, j) => (
              <li key={j}>{inline(item)}</li>
            ))}
          </ul>
        ) : (
          <ol key={i} className="list-decimal pl-5 space-y-0.5">
            {b.items.map((item, j) => (
              <li key={j}>{inline(item)}</li>
            ))}
          </ol>
        )
      )}
    </div>
  )
}

import { Sparkles } from "lucide-react"
import { requireStaff } from "@/lib/auth"
import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import { formatDate } from "@/lib/utils"
import { WHATS_NEW, type WhatsNewKind } from "@/lib/whats-new"

export const metadata = { title: "What's New — BuildFox" }

const KIND_TONE: Record<WhatsNewKind, "brand" | "info" | "success"> = {
  feature: "brand",
  improvement: "info",
  fix: "success",
}

const KIND_LABEL: Record<WhatsNewKind, string> = {
  feature: "New",
  improvement: "Improved",
  fix: "Fixed",
}

export default async function WhatsNewPage() {
  await requireStaff()

  // Group by date, newest first (the source array is already newest-first).
  const byDate = new Map<string, typeof WHATS_NEW>()
  for (const entry of WHATS_NEW) {
    const list = byDate.get(entry.date)
    if (list) list.push(entry)
    else byDate.set(entry.date, [entry])
  }

  return (
    <div className="max-w-3xl mx-auto px-4 md:px-6 py-6">
      <div className="mb-5">
        <h1 className="text-2xl font-semibold inline-flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-brand-500" />
          What&apos;s New
        </h1>
        <p className="text-sm text-muted mt-1">
          Features, improvements, and fixes as they ship — newest first. Short
          on purpose; ask if you want the full story on any of them.
        </p>
      </div>

      <div className="space-y-4">
        {[...byDate.entries()].map(([date, entries]) => (
          <Card key={date}>
            <div className="px-4 py-2.5 bg-background/60 border-b border-border text-xs uppercase tracking-wide text-muted font-medium">
              {formatDate(date)}
            </div>
            <ul className="divide-y divide-border">
              {entries.map((e, i) => (
                <li key={i} className="px-4 py-2.5 flex items-start gap-2.5">
                  <span className="mt-0.5 shrink-0 w-[4.5rem]">
                    <Badge tone={KIND_TONE[e.kind]}>{KIND_LABEL[e.kind]}</Badge>
                  </span>
                  <span className="text-sm">{e.title}</span>
                </li>
              ))}
            </ul>
          </Card>
        ))}
      </div>
    </div>
  )
}

"use client"

import { Input } from "@/components/ui/input"
import { suggestSimilarTags, applyTagSuggestion } from "@/lib/template-tags"

/**
 * Template-tags text field with a "reuse an existing tag" suggestion row.
 * As the user types a tag, existing tags similar to it surface as chips;
 * clicking one drops it in instead of coining a near-duplicate. `suggestions`
 * is the current tag vocabulary (base tags) drawn from the surrounding data.
 */
export function TemplateTagsInput({
  value,
  onChange,
  suggestions,
  placeholder,
}: {
  value: string
  onChange: (v: string) => void
  suggestions: string[]
  placeholder?: string
}) {
  const hits = suggestSimilarTags(value, suggestions)
  return (
    <div>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
      {hits.length > 0 && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1 text-[11px]">
          <span className="text-muted">Reuse an existing tag:</span>
          {hits.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => onChange(applyTagSuggestion(value, t))}
              className="rounded-full border border-border bg-surface px-2 py-0.5 font-mono text-foreground hover:border-brand-500 hover:text-brand-600 cursor-pointer"
            >
              {t}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

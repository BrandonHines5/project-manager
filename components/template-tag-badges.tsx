import { isNegatedTag, tagLabel } from "@/lib/template-tags"

// Template-tag chips for a list row. Only render these on template projects
// (callers gate on `is_template`) — the tags are inert once a template is
// copied into a real job, so they stay hidden there. A negated tag
// ("!walkout") reads as "not walkout". Shared by the schedule list view and
// the decisions table.
export function TemplateTagBadges({
  tags,
}: {
  tags: string[] | null | undefined
}) {
  if (!tags || tags.length === 0) return null
  return (
    <>
      {tags.map((tag) => (
        <span
          key={tag}
          className="inline-flex items-center text-[11px] text-purple-700 bg-purple-50 border border-purple-500/30 px-1.5 py-0.5 rounded"
          title="Template tag — controls whether this item is copied when creating a job from this template"
        >
          {isNegatedTag(tag) ? `not ${tagLabel(tag)}` : tagLabel(tag)}
        </span>
      ))}
    </>
  )
}

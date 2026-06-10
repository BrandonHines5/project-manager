// Template-tag helpers shared by the duplicate-project flow (server) and the
// tag editors / questionnaire (client).
//
// Model: template items (schedule_items, decisions) carry `template_tags`.
// When a project is created from a template, staff answer a yes/no question
// per distinct tag ("Walkout basement?") and an item is copied only when ALL
// of its tags match the answers:
//   - "walkout"  matches when the walkout answer is YES
//   - "!walkout" matches when the walkout answer is NO (or unanswered)
// An item with no tags always copies. Tags are inert outside duplication.

/** Boolean answers keyed by base tag, e.g. { walkout: true }. */
export type TemplateAttributes = Record<string, boolean>

export function isNegatedTag(tag: string): boolean {
  return tag.startsWith("!")
}

/** "!walkout" → "walkout"; "walkout" → "walkout". */
export function baseTag(tag: string): string {
  return isNegatedTag(tag) ? tag.slice(1) : tag
}

/**
 * Normalize one tag: lowercase, spaces → underscores, strip anything that
 * isn't [a-z0-9_-] (preserving a single leading "!"). Returns "" when nothing
 * survives so callers can drop it.
 */
export function normalizeTag(raw: string): string {
  const negated = raw.trim().startsWith("!")
  const body = raw
    .trim()
    .replace(/^!+/, "")
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_-]/g, "")
  if (!body) return ""
  return negated ? `!${body}` : body
}

/** Parse a comma-separated editor string into a de-duped normalized list. */
export function parseTagsInput(raw: string): string[] {
  const out: string[] = []
  for (const part of raw.split(",")) {
    const tag = normalizeTag(part)
    if (tag && !out.includes(tag)) out.push(tag)
  }
  return out
}

/** Editor display form of a stored tag list. */
export function formatTags(tags: string[] | null | undefined): string {
  return (tags ?? []).join(", ")
}

/** "finished_basement" → "Finished basement" (for questionnaire labels). */
export function tagLabel(tag: string): string {
  const words = baseTag(tag).replace(/[_-]+/g, " ").trim()
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : tag
}

/**
 * Should an item carrying `tags` be copied for a project answered with
 * `attrs`? Every tag must match; an unanswered attribute counts as NO.
 */
export function matchesTemplateTags(
  tags: string[] | null | undefined,
  attrs: TemplateAttributes
): boolean {
  for (const tag of tags ?? []) {
    const answer = attrs[baseTag(tag)] === true
    if (isNegatedTag(tag) ? answer : !answer) return false
  }
  return true
}

/**
 * Distinct base tags across a template's items, sorted — one questionnaire
 * question per entry.
 */
export function collectBaseTags(tagLists: (string[] | null | undefined)[]): string[] {
  const set = new Set<string>()
  for (const tags of tagLists) {
    for (const tag of tags ?? []) {
      const b = baseTag(tag)
      if (b) set.add(b)
    }
  }
  return [...set].sort()
}

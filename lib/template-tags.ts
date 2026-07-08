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

// ---- Tag groups (settings-defined either/or choices) ----------------------
// Staff define named groups of mutually-exclusive option tags in Settings →
// Template tags (stored as JSON in app_settings, key 'template_tag_groups').
// A "required" group must be answered when creating a project from a template
// before it can be created. Picking an option sets that option's attribute
// true and the group's other options false, so groups ride on the same
// boolean TemplateAttributes model the matcher already uses.

export type TemplateTagGroup = {
  id: string
  label: string
  required: boolean
  /** Mutually-exclusive option tags (positive, normalized), e.g. ["single_level","multi_level"]. */
  options: string[]
}

export type TemplateTagConfig = { groups: TemplateTagGroup[] }

/** Defensive parse of the stored JSON config — never throws, drops junk. */
export function parseTagGroupConfig(
  raw: string | null | undefined
): TemplateTagConfig {
  if (!raw) return { groups: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { groups: [] }
  }
  const groupsRaw =
    parsed && typeof parsed === "object"
      ? (parsed as { groups?: unknown }).groups
      : null
  if (!Array.isArray(groupsRaw)) return { groups: [] }
  const groups: TemplateTagGroup[] = []
  for (const g of groupsRaw) {
    if (!g || typeof g !== "object") continue
    const gg = g as Record<string, unknown>
    const id = typeof gg.id === "string" ? gg.id : ""
    const label = typeof gg.label === "string" ? gg.label.trim() : ""
    const required = gg.required === true
    const options = Array.isArray(gg.options)
      ? [
          ...new Set(
            gg.options
              .filter((o): o is string => typeof o === "string")
              // Group options are positive base tags — negation is meaningless
              // for a mutually-exclusive pick.
              .map((o) => baseTag(normalizeTag(o)))
              .filter(Boolean)
          ),
        ]
      : []
    if (!id || !label || options.length === 0) continue
    groups.push({ id, label, required, options })
  }
  return { groups }
}

/**
 * Fold a group's single-select answers into the boolean attribute map the
 * matcher consumes: the picked option becomes true, every sibling option in
 * that group becomes false. Only groups the caller decided to show are passed.
 */
export function attributesWithGroupSelections(
  base: TemplateAttributes,
  shownGroups: TemplateTagGroup[],
  selections: Record<string, string>
): TemplateAttributes {
  const attrs: TemplateAttributes = { ...base }
  for (const group of shownGroups) {
    const chosen = selections[group.id]
    for (const opt of group.options) attrs[opt] = chosen === opt
  }
  return attrs
}

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

// ---- Tag auto-suggest ------------------------------------------------------
// Surfacing existing tags similar to what's being typed keeps the vocabulary
// from drifting into near-duplicates (spec vs spec_home, in_city vs
// in_city_limits) — the exact mess a manual tag review has to clean up later.

/** The in-progress (last, comma-delimited) token in a tags editor string. */
export function currentTagToken(input: string): string {
  return (input.split(",").pop() ?? "").trim()
}

function sharedPrefix(a: string, b: string): number {
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  return i
}

// Higher = more similar; 0 = not worth suggesting.
function similarityScore(a: string, b: string): number {
  if (a === b) return 0
  if (b.startsWith(a) || a.startsWith(b)) return 100 + sharedPrefix(a, b)
  if (b.includes(a) || a.includes(b)) return 60
  const sp = sharedPrefix(a, b)
  return sp >= 3 ? 30 + sp : 0
}

/**
 * Existing base tags similar to the token currently being typed in `input`,
 * so the user can reuse one instead of coining a variant. Excludes tags
 * already present in the input and the exact token being typed. With nothing
 * typed yet, returns the existing vocabulary (so it's discoverable).
 */
export function suggestSimilarTags(
  input: string,
  existing: string[],
  limit = 6
): string[] {
  const present = new Set(parseTagsInput(input).map(baseTag))
  const tokenBase = baseTag(normalizeTag(currentTagToken(input)))
  const pool = [...new Set(existing.map(baseTag).filter(Boolean))].filter(
    (t) => t !== tokenBase && !present.has(t)
  )
  if (!tokenBase) return pool.sort().slice(0, limit)
  return pool
    .map((t) => ({ t, s: similarityScore(tokenBase, t) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.t.localeCompare(b.t))
    .slice(0, limit)
    .map((x) => x.t)
}

/**
 * Replace the in-progress token in `input` with `tag` (preserving a leading
 * "!" negation the user already typed) and leave a trailing ", " so they can
 * keep going.
 */
export function applyTagSuggestion(input: string, tag: string): string {
  const negated = currentTagToken(input).startsWith("!")
  const chosen = (negated ? "!" : "") + tag
  const lastComma = input.lastIndexOf(",")
  const head = lastComma >= 0 ? `${input.slice(0, lastComma + 1)} ` : ""
  return `${head}${chosen}, `
}

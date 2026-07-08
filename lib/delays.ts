// Delay reasons are a staff-editable list (Settings → Delay reasons), stored
// as JSON in app_settings key `delay_reasons`. Each reason has a STABLE
// `value` (the slug written to schedule_delays.reason_category, which used to
// be a fixed enum) and an editable `label` shown in the UI. Renaming a reason
// only touches its label, so historical delay rows keep pointing at the same
// value; deleting a reason leaves old rows intact and the report humanizes the
// orphaned value.

export type DelayReason = { value: string; label: string }

// app_settings key holding the reason list. The settings page and the schedule
// page read app_settings directly with this literal.
export const DELAY_REASONS_KEY = "delay_reasons"

// The original six enum values, used as the seed and as the fallback whenever
// the setting is missing or unparseable.
export const DEFAULT_DELAY_REASONS: DelayReason[] = [
  { value: "weather", label: "Weather" },
  { value: "sub", label: "Subcontractor" },
  { value: "material", label: "Material" },
  { value: "owner_decision", label: "Owner decision" },
  { value: "permit", label: "Permit" },
  { value: "other", label: "Other" },
]

// Turn a label (or a raw value) into a stable, storage-safe slug.
export function slugifyReason(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60)
}

// Best-effort display for a value with no configured label (e.g. a reason that
// was later deleted, or an AI-logged "other"): "owner_decision" → "Owner decision".
export function humanizeReason(value: string): string {
  const s = value.replace(/_/g, " ").trim()
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : value
}

// Parse the stored JSON into a clean, de-duplicated list. Accepts either a bare
// array or `{ reasons: [...] }`. Falls back to the defaults on anything
// malformed so the picker is never empty.
export function parseDelayReasons(
  raw: string | null | undefined
): DelayReason[] {
  if (!raw) return DEFAULT_DELAY_REASONS
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return DEFAULT_DELAY_REASONS
  }
  const arr = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { reasons?: unknown })?.reasons)
      ? (parsed as { reasons: unknown[] }).reasons
      : null
  if (!arr) return DEFAULT_DELAY_REASONS
  const out: DelayReason[] = []
  const seen = new Set<string>()
  for (const r of arr) {
    const rec = r as { value?: unknown; label?: unknown }
    const label = typeof rec?.label === "string" ? rec.label.trim() : ""
    const rawValue =
      typeof rec?.value === "string" && rec.value.trim() ? rec.value : label
    const value = slugifyReason(rawValue)
    if (!label || !value || seen.has(value)) continue
    seen.add(value)
    out.push({ value, label })
  }
  return out.length ? out : DEFAULT_DELAY_REASONS
}

// Label for a stored value, degrading gracefully for unknown/deleted reasons.
export function delayReasonLabel(
  value: string,
  reasons: DelayReason[]
): string {
  return reasons.find((r) => r.value === value)?.label ?? humanizeReason(value)
}

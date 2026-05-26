// Parse the `ids` search-param into a clean list of UUIDs.
//
// Why a strict regex check: anything that goes into a `project_id=in.(...)`
// PostgREST filter must already be a valid UUID — otherwise the request
// fails with a type-cast error rather than just returning zero rows. We'd
// rather silently drop malformed entries (e.g. an aborted edit pasted into
// the URL) than 500 the whole page.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function parseProjectIds(raw: string | string[] | undefined): string[] {
  if (!raw) return []
  const flat = Array.isArray(raw) ? raw.join(",") : raw
  const ids = flat
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => UUID.test(s))
  // De-dupe while preserving order.
  return Array.from(new Set(ids))
}

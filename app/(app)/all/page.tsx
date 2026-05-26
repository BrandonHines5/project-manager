import { redirect } from "next/navigation"
import { parseProjectIds } from "./parse-ids"

// Bare /all has no content of its own — send the user to the schedule view
// which is the most-likely landing spot from the sidebar footer. Preserve
// any incoming `?ids=` so deep links like /all?ids=... don't lose the
// selection on the redirect.
export default async function AllIndexPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = await searchParams
  const ids = parseProjectIds(params.ids)
  redirect(ids.length ? `/all/schedule?ids=${ids.join(",")}` : "/all/schedule")
}

import { redirect } from "next/navigation"
import { requireSession } from "@/lib/auth"

export default async function ProjectIndex({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const profile = await requireSession()
  // Clients never see the schedule; send them to the daily logs feed instead.
  const dest = profile.role === "client" ? "daily-logs" : "schedule"
  redirect(`/projects/${id}/${dest}`)
}

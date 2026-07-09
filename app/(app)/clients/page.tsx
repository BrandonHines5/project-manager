import { createSupabaseServerClient } from "@/lib/supabase/server"
import { requireStaff } from "@/lib/auth"
import { ClientsClient, type ClientRow, type ClientJob } from "./clients-client"

export const metadata = { title: "Clients — Hines Homes" }

/**
 * Clients directory. Aggregates the client contacts recorded on every job
 * (projects.client_name/email/phone + the second slot, mirrored from the
 * dashboard) into one row per person, listing the job(s) they're on. Read
 * only — client identity is dashboard-owned, edited on the job itself.
 */
export default async function ClientsPage() {
  await requireStaff()
  const supabase = await createSupabaseServerClient()

  const { data: projects, error } = await supabase
    .from("projects")
    .select(
      "id, project_number, name, status, client_name, client_email, client_phone, client_name_2, client_email_2, client_phone_2"
    )
    .eq("is_template", false)
    .order("project_number")
  if (error) throw new Error(error.message)

  // Group contacts across jobs. Key on email when present (so the same person
  // on two jobs collapses to one row), else on name.
  const byKey = new Map<string, ClientRow>()
  const addContact = (
    name: string | null,
    email: string | null,
    phone: string | null,
    job: ClientJob
  ) => {
    const cleanName = name?.trim() ?? ""
    const cleanEmail = email?.trim() ?? ""
    const cleanPhone = phone?.trim() ?? ""
    if (!cleanName && !cleanEmail) return
    const key = (cleanEmail || cleanName).toLowerCase()
    let row = byKey.get(key)
    if (!row) {
      row = {
        key,
        name: cleanName || cleanEmail,
        email: cleanEmail || null,
        phone: cleanPhone || null,
        jobs: [],
      }
      byKey.set(key, row)
    } else {
      // Backfill any detail an earlier job left blank.
      if (row.name === row.email && cleanName) row.name = cleanName
      if (!row.email && cleanEmail) row.email = cleanEmail
      if (!row.phone && cleanPhone) row.phone = cleanPhone
    }
    if (!row.jobs.some((j) => j.id === job.id)) row.jobs.push(job)
  }

  for (const p of projects ?? []) {
    const job: ClientJob = {
      id: p.id,
      number: p.project_number,
      name: p.name,
      status: p.status,
    }
    addContact(p.client_name, p.client_email, p.client_phone, job)
    addContact(p.client_name_2, p.client_email_2, p.client_phone_2, job)
  }

  const clients = Array.from(byKey.values()).sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
  )

  return <ClientsClient clients={clients} />
}

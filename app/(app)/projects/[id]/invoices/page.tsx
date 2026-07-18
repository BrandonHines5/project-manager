import { notFound } from "next/navigation"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { requireSession } from "@/lib/auth"
import { InvoicesClient } from "./invoices-client"

export const metadata = { title: "Invoices — BuildFox" }

export default async function ProjectInvoicesPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id: projectId } = await params
  const profile = await requireSession()
  // Trades never see client invoices — the tab is hidden for them and RLS
  // returns no rows; a 404 keeps a hand-typed URL honest too.
  if (profile.role === "trade") notFound()

  const supabase = await createSupabaseServerClient()
  const { data: project } = await supabase
    .from("projects")
    .select("id, name, qbo_customer_id, qbo_customer_name")
    .eq("id", projectId)
    .maybeSingle()
  if (!project) notFound()

  // RLS scopes this per role: staff see everything (incl. voided/deleted for
  // history), clients only open/paid on their own projects.
  const { data: invoices, error } = await supabase
    .from("qbo_invoices")
    .select("*")
    .eq("project_id", projectId)
    .order("txn_date", { ascending: false, nullsFirst: false })
  if (error) throw new Error(error.message)

  return (
    <InvoicesClient
      projectId={project.id}
      isStaff={profile.role === "staff"}
      linkedCustomer={
        project.qbo_customer_id
          ? {
              id: project.qbo_customer_id,
              name: project.qbo_customer_name ?? project.qbo_customer_id,
            }
          : null
      }
      invoices={invoices ?? []}
    />
  )
}

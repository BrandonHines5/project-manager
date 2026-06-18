import { ShieldCheck } from "lucide-react"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { requireStaff } from "@/lib/auth"
import { EmptyState } from "@/components/ui/empty"
import { WarrantySheet } from "@/components/warranty/warranty-sheet"
import type {
  WarrantyHome,
  WarrantyItem,
  WarrantyCompany,
} from "@/components/warranty/warranty-sheet"
import type { Enums } from "@/lib/db/types"

export const metadata = { title: "Warranty — Hines Homes" }

export default async function WarrantyPage() {
  await requireStaff()
  const supabase = await createSupabaseServerClient()

  // Homes currently in the warranty phase. RLS still applies.
  const { data: projects, error: projErr } = await supabase
    .from("projects")
    .select(
      "id, project_number, name, address, client_name, client_name_2, warranty_end_date"
    )
    .eq("status", "warranty")
    .order("project_number")
  if (projErr) throw new Error(projErr.message)

  const projectIds = (projects ?? []).map((p) => p.id)

  type ItemRow = {
    id: string
    project_id: string
    title: string
    due_date: string | null
    status: Enums<"schedule_item_status">
    warranty_date_noted: string | null
    warranty_resolution: string | null
    updated_at: string
  }

  let itemRows: ItemRow[] = []
  const assigneeByItem = new Map<string, string>()
  let companies: WarrantyCompany[] = []

  if (projectIds.length) {
    const [{ data: items, error: itemsErr }, { data: comps, error: compErr }] =
      await Promise.all([
        // Every to-do on a warranty home IS a warranty issue. We load all of
        // them (open + complete) and let the grid filter — default is open.
        supabase
          .from("schedule_items")
          .select(
            "id, project_id, title, due_date, status, warranty_date_noted, warranty_resolution, updated_at"
          )
          .in("project_id", projectIds)
          .eq("kind", "todo"),
        supabase.from("companies").select("id, name").order("name"),
      ])
    if (itemsErr) throw new Error(itemsErr.message)
    if (compErr) throw new Error(compErr.message)
    itemRows = items ?? []
    companies = comps ?? []

    const itemIds = itemRows.map((i) => i.id)
    if (itemIds.length) {
      // "Who is Fixing It" = the company assigned to the issue.
      const { data: assignments, error: aErr } = await supabase
        .from("schedule_assignments")
        .select("schedule_item_id, company_id")
        .in("schedule_item_id", itemIds)
        .not("company_id", "is", null)
      if (aErr) throw new Error(aErr.message)
      for (const a of assignments ?? []) {
        if (a.company_id && !assigneeByItem.has(a.schedule_item_id)) {
          assigneeByItem.set(a.schedule_item_id, a.company_id)
        }
      }
    }
  }

  const itemsByProject = new Map<string, WarrantyItem[]>()
  for (const r of itemRows) {
    const arr = itemsByProject.get(r.project_id) ?? []
    arr.push({
      id: r.id,
      project_id: r.project_id,
      title: r.title,
      due_date: r.due_date,
      status: r.status,
      warranty_date_noted: r.warranty_date_noted,
      warranty_resolution: r.warranty_resolution,
      company_id: assigneeByItem.get(r.id) ?? null,
      updated_at: r.updated_at,
    })
    itemsByProject.set(r.project_id, arr)
  }
  // Earliest "date noted" first, then earliest due, within each home.
  for (const arr of itemsByProject.values()) {
    arr.sort((a, b) => {
      // Undated items sort last (consistent with due_date handling below).
      const an = a.warranty_date_noted ?? "9999-12-31"
      const bn = b.warranty_date_noted ?? "9999-12-31"
      if (an !== bn) return an.localeCompare(bn)
      const ad = a.due_date ?? "9999-12-31"
      const bd = b.due_date ?? "9999-12-31"
      return ad.localeCompare(bd)
    })
  }

  const homes: WarrantyHome[] = (projects ?? []).map((p) => ({
    id: p.id,
    project_number: p.project_number,
    name: p.name,
    address: p.address,
    client_name: p.client_name,
    client_name_2: p.client_name_2,
    warranty_end_date: p.warranty_end_date,
    items: itemsByProject.get(p.id) ?? [],
  }))

  return (
    <div className="max-w-7xl mx-auto px-4 md:px-6 py-5">
      <div className="mb-5">
        <h1 className="text-lg font-semibold flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-brand-600" />
          Warranty
        </h1>
        <p className="text-sm text-muted mt-0.5">
          Track open warranty items for each home in the warranty phase. Edit any
          cell inline — changes save automatically.
        </p>
      </div>

      {homes.length === 0 ? (
        <EmptyState
          icon={<ShieldCheck className="h-8 w-8" />}
          title="No projects in warranty"
          description="Move a project to the Warranty status from its edit dialog to track open warranty items here."
        />
      ) : (
        <WarrantySheet homes={homes} companies={companies} />
      )}
    </div>
  )
}

import { ShieldCheck } from "lucide-react"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { requireStaff } from "@/lib/auth"
import { EmptyState } from "@/components/ui/empty"
import { WarrantySheet } from "@/components/warranty/warranty-sheet"
import type {
  TrackerCard,
  TrackerItem,
} from "@/components/warranty/warranty-sheet"
import type { Enums } from "@/lib/db/types"

export const metadata = { title: "Warranty / Rental — Hines Homes" }

type Status = Enums<"schedule_item_status">

export default async function WarrantyPage() {
  await requireStaff()
  const supabase = await createSupabaseServerClient()

  const [{ data: projects, error: projErr }, { data: properties, error: propErr }] =
    await Promise.all([
      supabase
        .from("projects")
        .select(
          "id, project_number, name, address, client_name, client_name_2, warranty_end_date"
        )
        .eq("status", "warranty")
        .order("project_number"),
      supabase
        .from("rental_properties")
        .select("id, address, tenant_name, property_owner")
        .order("address"),
    ])
  if (projErr) throw new Error(projErr.message)
  if (propErr) throw new Error(propErr.message)

  const projectIds = (projects ?? []).map((p) => p.id)
  const propertyIds = (properties ?? []).map((p) => p.id)

  type WItem = {
    id: string
    project_id: string
    title: string
    due_date: string | null
    status: Status
    warranty_date_noted: string | null
    warranty_resolution: string | null
    warranty_who_fixing: string | null
    warranty_no_action: boolean
    updated_at: string
  }
  type RItem = {
    id: string
    rental_property_id: string
    title: string
    due_date: string | null
    status: Status
    date_noted: string | null
    resolution: string | null
    who_fixing: string | null
    no_action: boolean
    updated_at: string
  }

  let warrantyItems: WItem[] = []
  let rentalItems: RItem[] = []
  if (projectIds.length) {
    const { data, error } = await supabase
      .from("schedule_items")
      .select(
        "id, project_id, title, due_date, status, warranty_date_noted, warranty_resolution, warranty_who_fixing, warranty_no_action, updated_at"
      )
      .in("project_id", projectIds)
      .eq("kind", "todo")
    if (error) throw new Error(error.message)
    warrantyItems = data ?? []
  }
  if (propertyIds.length) {
    const { data, error } = await supabase
      .from("rental_items")
      .select(
        "id, rental_property_id, title, due_date, status, date_noted, resolution, who_fixing, no_action, updated_at"
      )
      .in("rental_property_id", propertyIds)
    if (error) throw new Error(error.message)
    rentalItems = data ?? []
  }

  const sortItems = (a: TrackerItem, b: TrackerItem) => {
    const an = a.date_noted ?? "9999-12-31"
    const bn = b.date_noted ?? "9999-12-31"
    if (an !== bn) return an.localeCompare(bn)
    return (a.due_date ?? "9999-12-31").localeCompare(b.due_date ?? "9999-12-31")
  }

  const warrantyByProject = new Map<string, TrackerItem[]>()
  for (const r of warrantyItems) {
    const arr = warrantyByProject.get(r.project_id) ?? []
    arr.push({
      id: r.id,
      kind: "warranty",
      card_id: r.project_id,
      title: r.title,
      date_noted: r.warranty_date_noted,
      resolution: r.warranty_resolution,
      who_fixing: r.warranty_who_fixing,
      due_date: r.due_date,
      status: r.status,
      no_action: r.warranty_no_action,
      updated_at: r.updated_at,
    })
    warrantyByProject.set(r.project_id, arr)
  }
  const rentalByProperty = new Map<string, TrackerItem[]>()
  for (const r of rentalItems) {
    const arr = rentalByProperty.get(r.rental_property_id) ?? []
    arr.push({
      id: r.id,
      kind: "rental",
      card_id: r.rental_property_id,
      title: r.title,
      date_noted: r.date_noted,
      resolution: r.resolution,
      who_fixing: r.who_fixing,
      due_date: r.due_date,
      status: r.status,
      no_action: r.no_action,
      updated_at: r.updated_at,
    })
    rentalByProperty.set(r.rental_property_id, arr)
  }
  for (const arr of warrantyByProject.values()) arr.sort(sortItems)
  for (const arr of rentalByProperty.values()) arr.sort(sortItems)

  const warrantyCards: TrackerCard[] = (projects ?? []).map((p) => {
    const owner = [p.client_name, p.client_name_2]
      .filter((n): n is string => !!n && n.trim().length > 0)
      .join(" & ")
    return {
      id: p.id,
      kind: "warranty",
      number: p.project_number,
      address: p.address || p.name,
      subtitle: `Owner: ${owner || "—"}`,
      warranty_end_date: p.warranty_end_date,
      href: `/projects/${p.id}/schedule`,
      items: warrantyByProject.get(p.id) ?? [],
    }
  })

  const rentalCards: TrackerCard[] = (properties ?? []).map((p) => ({
    id: p.id,
    kind: "rental",
    number: null,
    address: p.address,
    subtitle: `Tenant: ${p.tenant_name || "—"}${
      p.property_owner ? ` · Owner: ${p.property_owner}` : ""
    }`,
    warranty_end_date: null,
    href: null,
    items: rentalByProperty.get(p.id) ?? [],
  }))

  const cards = [...warrantyCards, ...rentalCards]

  return (
    <div className="px-4 md:px-6 py-5">
      <div className="mb-5">
        <h1 className="text-lg font-semibold flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-brand-600" />
          Warranty / Rental
        </h1>
        <p className="text-sm text-muted mt-0.5">
          Track open warranty items for homes in the warranty phase and open
          issues at rental properties. Edit any cell inline — changes save
          automatically.
        </p>
      </div>

      {cards.length === 0 ? (
        <EmptyState
          icon={<ShieldCheck className="h-8 w-8" />}
          title="Nothing to track yet"
          description="Move a project to the Warranty status, or sync rentals from the CRM, to start tracking items here."
        />
      ) : (
        <WarrantySheet cards={cards} />
      )}
    </div>
  )
}

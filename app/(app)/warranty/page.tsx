import { ShieldCheck } from "lucide-react"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { createCrmClient } from "@/lib/supabase/crm"
import { requireStaff } from "@/lib/auth"
import { EmptyState } from "@/components/ui/empty"
import { WarrantySheet } from "@/components/warranty/warranty-sheet"
import { AddWarrantyProjectButton } from "@/components/warranty/add-warranty-project"
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
        .select("id, crm_rental_id, address, tenant_name, property_owner")
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

  // Live read of property identity (address / tenant / owner) straight from the
  // CRM database, keyed by crm_rental_id. Falls back to the local cache when the
  // CRM connection isn't configured or a read fails — the page never breaks.
  const liveByCrmId = await fetchLiveRentalInfo()

  const rentalCards: TrackerCard[] = (properties ?? []).map((p) => {
    const live = p.crm_rental_id ? liveByCrmId.get(p.crm_rental_id) : undefined
    const address = live?.address ?? p.address
    const tenant = live?.tenant ?? p.tenant_name
    const owner = live?.owner ?? p.property_owner
    return {
      id: p.id,
      kind: "rental",
      number: null,
      address,
      subtitle: `Tenant: ${tenant || "—"}${owner ? ` · Owner: ${owner}` : ""}`,
      warranty_end_date: null,
      href: null,
      items: rentalByProperty.get(p.id) ?? [],
    }
  })

  const cards = [...warrantyCards, ...rentalCards]

  return (
    <div className="px-4 md:px-6 py-5">
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
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
        <AddWarrantyProjectButton />
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

type LiveRental = { address: string | null; tenant: string | null; owner: string | null }

// Reads rental property identity directly from the CRM database (any columns,
// no per-column API). Returns an empty map — so the page falls back to the
// local cache — when the CRM connection isn't configured or a read fails.
async function fetchLiveRentalInfo(): Promise<Map<string, LiveRental>> {
  const map = new Map<string, LiveRental>()
  const crm = createCrmClient()
  if (!crm) return map
  try {
    const [rentalsRes, clientsRes] = await Promise.all([
      crm
        .from("rentals")
        .select("id, property_address, property_owner, client_id, client_id_2"),
      crm.from("clients").select("id, name"),
    ])
    // Supabase returns errors on the result object rather than throwing, so log
    // them explicitly — otherwise a bad CRM key / renamed table fails silently
    // and the page just shows cached data with no clue why.
    if (rentalsRes.error || clientsRes.error) {
      console.warn(
        "[warranty] live CRM rental read failed; using cache:",
        rentalsRes.error ?? clientsRes.error
      )
    }
    const rentals = rentalsRes.data
    const clients = clientsRes.data
    const nameById = new Map<string, string>()
    for (const c of (clients ?? []) as { id: string; name: string | null }[]) {
      if (c.name) nameById.set(c.id, c.name)
    }
    type CrmRental = {
      id: string
      property_address: string | null
      property_owner: string | null
      client_id: string | null
      client_id_2: string | null
    }
    for (const r of (rentals ?? []) as CrmRental[]) {
      const tenant = [r.client_id, r.client_id_2]
        .map((id) => (id ? nameById.get(id) : null))
        .filter((n): n is string => !!n)
        .join(" & ")
      map.set(r.id, {
        address: r.property_address || null,
        tenant: tenant || null,
        owner: r.property_owner,
      })
    }
  } catch (e) {
    console.warn("[warranty] live CRM rental read failed; using cache:", e)
  }
  return map
}

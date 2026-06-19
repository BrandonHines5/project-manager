"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { createCrmClient } from "@/lib/supabase/crm"
import { requireStaff } from "@/lib/auth"
import type { TablesUpdate } from "@/lib/db/types"

const nullableDate = z
  .string()
  .nullable()
  .optional()
  .or(z.literal("").transform(() => null))

// Patches only the rental columns it's handed (parallels updateWarrantyItem).
const RentalItemInput = z.object({
  id: z.string().min(1),
  title: z.string().trim().min(1, "Issue is required").max(500).optional(),
  date_noted: nullableDate,
  resolution: z
    .string()
    .max(5000)
    .nullable()
    .optional()
    .or(z.literal("").transform(() => null)),
  who_fixing: z
    .string()
    .max(500)
    .nullable()
    .optional()
    .or(z.literal("").transform(() => null)),
  due_date: nullableDate,
  status: z
    .enum(["not_started", "in_progress", "complete", "delayed"])
    .optional(),
  no_action: z.boolean().optional(),
})

export async function updateRentalItem(
  input: z.input<typeof RentalItemInput>
) {
  await requireStaff()
  const parsed = RentalItemInput.safeParse(input)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    throw new Error(
      `Invalid rental item: ${first.path.join(".") || "(root)"}: ${first.message}`
    )
  }
  const { id, ...fields } = parsed.data
  const update: TablesUpdate<"rental_items"> = {}
  if (fields.title !== undefined) update.title = fields.title
  if (fields.date_noted !== undefined) update.date_noted = fields.date_noted
  if (fields.resolution !== undefined) update.resolution = fields.resolution
  if (fields.who_fixing !== undefined) update.who_fixing = fields.who_fixing
  if (fields.due_date !== undefined) update.due_date = fields.due_date
  if (fields.status !== undefined) update.status = fields.status
  if (fields.no_action !== undefined) update.no_action = fields.no_action
  if (Object.keys(update).length === 0) return

  const supabase = await createSupabaseServerClient()
  const { error } = await supabase
    .from("rental_items")
    .update(update)
    .eq("id", id)
  if (error) throw new Error(error.message)
  revalidatePath("/warranty")
}

const CreateRentalItemInput = z.object({
  rental_property_id: z.string().min(1),
  title: z.string().trim().max(500).optional(),
})

export async function createRentalItem(
  input: z.input<typeof CreateRentalItemInput>
) {
  const profile = await requireStaff()
  const parsed = CreateRentalItemInput.parse(input)
  const supabase = await createSupabaseServerClient()
  const { data, error } = await supabase
    .from("rental_items")
    .insert({
      rental_property_id: parsed.rental_property_id,
      title: parsed.title?.trim() || "New rental item",
      status: "not_started",
      created_by: profile.id,
    })
    .select("id")
    .single()
  if (error) throw new Error(error.message)
  revalidatePath("/warranty")
  return { id: data.id as string }
}

export async function deleteRentalItem(input: { id: string }) {
  await requireStaff()
  const id = z.string().min(1).parse(input.id)
  const supabase = await createSupabaseServerClient()
  const { error } = await supabase.from("rental_items").delete().eq("id", id)
  if (error) throw new Error(error.message)
  revalidatePath("/warranty")
}

type CrmRentalRow = {
  id: string
  property_address: string | null
  property_owner: string | null
  lease_status: string | null
  client_id: string | null
  client_id_2: string | null
}
type CrmClientRow = { id: string; name: string | null }

// Refreshes the local rental_properties cache directly from the CRM database
// (whole tables, not a per-column API). No-op with a typed result if the CRM
// connection isn't configured.
export async function syncRentalsFromCrm(): Promise<
  { ok: true; synced: number } | { ok: false; error: string }
> {
  await requireStaff()
  const crm = createCrmClient()
  if (!crm) {
    return {
      ok: false,
      error:
        "CRM connection not configured. Set CRM_SUPABASE_URL and CRM_SUPABASE_SERVICE_ROLE_KEY in Vercel.",
    }
  }

  const [{ data: rentals, error: rErr }, { data: clients, error: cErr }] =
    await Promise.all([
      crm
        .from("rentals")
        .select(
          "id, property_address, property_owner, lease_status, client_id, client_id_2"
        ),
      crm.from("clients").select("id, name"),
    ])
  if (rErr) return { ok: false, error: rErr.message }
  if (cErr) return { ok: false, error: cErr.message }

  const nameById = new Map<string, string>()
  for (const c of (clients ?? []) as CrmClientRow[]) {
    if (c.name) nameById.set(c.id, c.name)
  }

  const rows = ((rentals ?? []) as CrmRentalRow[])
    .filter((r) => r.property_address)
    .map((r) => {
      const tenant = [r.client_id, r.client_id_2]
        .map((id) => (id ? nameById.get(id) : null))
        .filter((n): n is string => !!n)
        .join(" & ")
      return {
        crm_rental_id: r.id,
        address: r.property_address as string,
        tenant_name: tenant || null,
        property_owner: r.property_owner,
        lease_status: r.lease_status,
        synced_at: new Date().toISOString(),
      }
    })

  const supabase = await createSupabaseServerClient()
  const { error } = await supabase
    .from("rental_properties")
    .upsert(rows, { onConflict: "crm_rental_id" })
  if (error) return { ok: false, error: error.message }
  revalidatePath("/warranty")
  return { ok: true, synced: rows.length }
}

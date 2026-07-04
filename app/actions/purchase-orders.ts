"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { requireStaff } from "@/lib/auth"
import { sendEmail, appUrl } from "@/lib/email"
import { sendQuoSms, normalizeE164 } from "@/lib/quo"
import { generateAccessToken } from "@/lib/tokens"
import { formatDate } from "@/lib/utils"

const optStr = z.string().nullish()

const LineItem = z.object({
  id: optStr,
  cost_code_id: optStr,
  description: z.string().min(1),
  quantity: z.coerce.number().default(1),
  unit: optStr,
  unit_cost: z.coerce.number().default(0),
})

const Attachment = z.object({
  id: optStr,
  storage_path: z.string(),
  file_name: z.string(),
  file_type: optStr,
  file_size: z.number().nullish(),
  caption: optStr,
})

const PurchaseOrderInput = z
  .object({
    id: optStr,
    project_id: z.string(),
    title: z.string().min(1).max(300),
    scope: optStr,
    company_id: z.string().min(1, "Pick a sub/vendor."),
    custom_number: optStr,
    approval_deadline: optStr,
    flat_fee: z.boolean().default(false),
    flat_total: z.coerce.number().nullish(),
    line_items: z.array(LineItem).default([]),
    attachments: z.array(Attachment).default([]),
  })
  .superRefine((po, ctx) => {
    if (po.flat_fee && po.flat_total == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Enter the flat-fee amount.",
        path: ["flat_total"],
      })
    }
  })

export type PurchaseOrderInputT = z.infer<typeof PurchaseOrderInput>

function nz(v: string | null | undefined) {
  return v && v !== "" ? v : null
}

/**
 * Create or update a PO. Structural edits (line items, vendor, pricing)
 * are draft-only — a released PO must be unreleased first so the sub is
 * never approving a document that changed under them.
 */
export async function savePurchaseOrder(input: PurchaseOrderInputT) {
  const profile = await requireStaff()
  const result = PurchaseOrderInput.safeParse(input)
  if (!result.success) {
    const first = result.error.issues[0]
    throw new Error(
      `Invalid form data at ${first.path.join(".") || "(root)"}: ${first.message}`
    )
  }
  const parsed = result.data
  const supabase = await createSupabaseServerClient()

  const row = {
    title: parsed.title,
    scope: parsed.scope ?? null,
    company_id: parsed.company_id,
    custom_number: nz(parsed.custom_number),
    approval_deadline: nz(parsed.approval_deadline),
    flat_fee: parsed.flat_fee,
    flat_total: parsed.flat_fee ? parsed.flat_total ?? null : null,
  }

  let id = nz(parsed.id)
  if (id) {
    const { data: cur, error: curErr } = await supabase
      .from("purchase_orders")
      .select("status")
      .eq("id", id)
      .maybeSingle()
    if (curErr) throw new Error(curErr.message)
    if (!cur) throw new Error("Purchase order not found")
    if (cur.status !== "draft") {
      throw new Error("Only draft POs can be edited — unrelease it first.")
    }
    const { error, count } = await supabase
      .from("purchase_orders")
      .update(row, { count: "exact" })
      .eq("id", id)
      .eq("status", "draft")
    if (error) throw new Error(error.message)
    // Zero rows = the PO left draft between the pre-check and this update
    // (concurrent release). Bail before the line-item wipe below.
    if (!count) {
      throw new Error("Only draft POs can be edited — unrelease it first.")
    }
  } else {
    // Race-safe per-project number, same pattern as saveDecision.
    let inserted: { id: string } | null = null
    for (let attempt = 0; attempt < 5 && !inserted; attempt++) {
      const { data: nextNum, error: rpcErr } = await supabase.rpc(
        "next_po_number",
        { p_project: parsed.project_id }
      )
      if (rpcErr) throw new Error(rpcErr.message)
      const { data, error } = await supabase
        .from("purchase_orders")
        .insert({
          ...row,
          project_id: parsed.project_id,
          number: Number(nextNum),
          created_by: profile.id,
        })
        .select("id")
        .single()
      if (!error) {
        inserted = data
        break
      }
      if (error.code !== "23505") throw new Error(error.message)
      await new Promise((r) => setTimeout(r, 25 + Math.random() * 50))
    }
    if (!inserted) {
      throw new Error("Could not allocate a PO number after 5 attempts.")
    }
    id = inserted.id
  }

  // Wipe-and-reinsert line items — nothing references them (unlike bid
  // package lines, which sub quotes FK).
  const { error: delErr } = await supabase
    .from("po_line_items")
    .delete()
    .eq("purchase_order_id", id)
  if (delErr) throw new Error(delErr.message)
  if (!parsed.flat_fee && parsed.line_items.length) {
    const { error } = await supabase.from("po_line_items").insert(
      parsed.line_items.map((li, i) => ({
        purchase_order_id: id!,
        cost_code_id: nz(li.cost_code_id),
        description: li.description,
        quantity: li.quantity,
        unit: li.unit ?? null,
        unit_cost: li.unit_cost,
        position: i,
      }))
    )
    if (error) throw new Error(error.message)
  }

  // Reconcile attachments (delete removed + blob cleanup, insert new,
  // update captions) — same shape as decisions.
  const { data: existingAtts, error: existingAttsErr } = await supabase
    .from("po_attachments")
    .select("id, storage_path")
    .eq("purchase_order_id", id)
  if (existingAttsErr) throw new Error(existingAttsErr.message)
  const keepIds = new Set(
    parsed.attachments.map((a) => nz(a.id)).filter((x): x is string => !!x)
  )
  const toDelete = (existingAtts ?? []).filter((e) => !keepIds.has(e.id))
  if (toDelete.length) {
    const { error } = await supabase
      .from("po_attachments")
      .delete()
      .in("id", toDelete.map((d) => d.id))
    if (error) throw new Error(error.message)
    const { error: storageErr } = await supabase.storage
      .from("project-files")
      .remove(toDelete.map((d) => d.storage_path))
    if (storageErr) {
      console.warn("[savePurchaseOrder] storage cleanup failed (non-fatal):", storageErr.message)
    }
  }
  const newOnes = parsed.attachments.filter((a) => !nz(a.id))
  if (newOnes.length) {
    const startPos = existingAtts?.length ?? 0
    const { error } = await supabase.from("po_attachments").insert(
      newOnes.map((a, i) => ({
        purchase_order_id: id!,
        storage_path: a.storage_path,
        file_name: a.file_name,
        file_type: a.file_type ?? null,
        file_size: a.file_size ?? null,
        caption: a.caption ?? null,
        position: startPos + i,
      }))
    )
    if (error) throw new Error(error.message)
  }
  for (const a of parsed.attachments.filter((a) => nz(a.id))) {
    const { error } = await supabase
      .from("po_attachments")
      .update({ caption: a.caption ?? null })
      .eq("id", a.id!)
      .eq("purchase_order_id", id)
    if (error) throw new Error(error.message)
  }

  revalidatePath(`/projects/${parsed.project_id}/purchase-orders`)
  return { id }
}

/**
 * Release a draft PO to the sub: mint a fresh access token, flip to
 * `released`, and email/SMS the company their public approval link.
 */
export async function releasePurchaseOrder({
  id,
  project_id,
}: {
  id: string
  project_id: string
}) {
  await requireStaff()
  const supabase = await createSupabaseServerClient()

  const { data: po, error: poErr } = await supabase
    .from("purchase_orders")
    .select(
      "id, number, title, approval_deadline, status, companies:company_id(name, email, phone, notifications_enabled), projects:project_id(name)"
    )
    .eq("id", id)
    .maybeSingle()
  if (poErr) throw new Error(poErr.message)
  if (!po) throw new Error("Purchase order not found")
  if (po.status !== "draft") throw new Error("Only a draft PO can be released.")

  const token = generateAccessToken()
  const { error, count } = await supabase
    .from("purchase_orders")
    .update(
      { status: "released", token, released_at: new Date().toISOString() },
      { count: "exact" }
    )
    .eq("id", id)
    .eq("status", "draft")
  if (error) throw new Error(error.message)
  // Never email a token that wasn't stored (concurrent release/void).
  if (!count) throw new Error("Only a draft PO can be released.")

  const company = (
    po as unknown as {
      companies: {
        name: string
        email: string | null
        phone: string | null
        notifications_enabled: boolean
      } | null
    }
  ).companies
  const projectName =
    (po as unknown as { projects: { name: string } | null }).projects?.name ?? "our project"

  if (company?.notifications_enabled) {
    const link = appUrl(`/po/${token}`)
    const deadlineLine = po.approval_deadline
      ? ` Please review and approve by ${formatDate(po.approval_deadline)}.`
      : ""
    const sendJobs: Promise<unknown>[] = []
    if (company.email) {
      sendJobs.push(
        sendEmail({
          to: [company.email],
          subject: `Purchase order PO-${po.number}: ${po.title} — ${projectName}`,
          text: `Hines Homes has issued you a purchase order for "${po.title}" on ${projectName}.${deadlineLine}\n\nReview and approve or decline here (no login needed):\n${link}`,
        }).catch((e) => console.warn("[releasePurchaseOrder] email failed:", e))
      )
    }
    const e164 = company.phone ? normalizeE164(company.phone) : null
    if (e164) {
      sendJobs.push(
        sendQuoSms({
          to: e164,
          content: `Hines Homes purchase order PO-${po.number} "${po.title}" on ${projectName}.${deadlineLine} Review & approve: ${link}`,
        }).catch((e) => console.warn("[releasePurchaseOrder] SMS failed:", e))
      )
    }
    await Promise.all(sendJobs)
  }

  revalidatePath(`/projects/${project_id}/purchase-orders`)
}

/**
 * Pull a PO back to draft for edits. Revokes the token (the old link goes
 * dead) and clears any approval/decline state — the sub re-approves the
 * revised document on the next release.
 */
export async function unreleasePurchaseOrder({
  id,
  project_id,
}: {
  id: string
  project_id: string
}) {
  await requireStaff()
  const supabase = await createSupabaseServerClient()
  const { data: cur, error: curErr } = await supabase
    .from("purchase_orders")
    .select("status")
    .eq("id", id)
    .maybeSingle()
  if (curErr) throw new Error(curErr.message)
  if (!cur) throw new Error("Purchase order not found")
  if (!["released", "approved", "declined"].includes(cur.status)) {
    throw new Error("Only a released, approved, or declined PO can be unreleased.")
  }
  const { error } = await supabase
    .from("purchase_orders")
    .update({
      status: "draft",
      token: null,
      released_at: null,
      approved_at: null,
      approved_signature: null,
      approved_by_profile_id: null,
      declined_at: null,
      decline_reason: null,
    })
    .eq("id", id)
    .eq("status", cur.status)
  if (error) throw new Error(error.message)
  revalidatePath(`/projects/${project_id}/purchase-orders`)
  // Unreleasing an approved PO pulls it out of committed costs.
  if (cur.status === "approved") {
    revalidatePath(`/projects/${project_id}/pricing`)
  }
}

/**
 * Approve on the sub's behalf (pen-and-paper subs). Records the typed
 * signature plus the staff member who entered it, so token approvals
 * (approved_by_profile_id null) stay distinguishable.
 */
export async function staffApprovePurchaseOrder({
  id,
  project_id,
  signature_name,
}: {
  id: string
  project_id: string
  signature_name: string
}) {
  const profile = await requireStaff()
  if (!signature_name.trim()) throw new Error("Enter the signer's name.")
  const supabase = await createSupabaseServerClient()
  const { error, count } = await supabase
    .from("purchase_orders")
    .update(
      {
        status: "approved",
        approved_at: new Date().toISOString(),
        approved_signature: signature_name.trim(),
        approved_by_profile_id: profile.id,
      },
      { count: "exact" }
    )
    .eq("id", id)
    .eq("status", "released")
  if (error) throw new Error(error.message)
  if (!count) throw new Error("Only a released PO can be approved.")
  revalidatePath(`/projects/${project_id}/purchase-orders`)
  revalidatePath(`/projects/${project_id}/pricing`)
}

/** Void rescinds the PO but keeps the record. Kills the public link. */
export async function voidPurchaseOrder({
  id,
  project_id,
}: {
  id: string
  project_id: string
}) {
  await requireStaff()
  const supabase = await createSupabaseServerClient()
  const { error, count } = await supabase
    .from("purchase_orders")
    .update(
      { status: "void", voided_at: new Date().toISOString(), token: null },
      { count: "exact" }
    )
    .eq("id", id)
    .neq("status", "void")
  if (error) throw new Error(error.message)
  if (!count) throw new Error("This PO is already void.")
  revalidatePath(`/projects/${project_id}/purchase-orders`)
  revalidatePath(`/projects/${project_id}/pricing`)
}

export async function setPoWorkComplete({
  id,
  project_id,
  complete,
}: {
  id: string
  project_id: string
  complete: boolean
}) {
  await requireStaff()
  const supabase = await createSupabaseServerClient()
  const { error } = await supabase
    .from("purchase_orders")
    .update({
      work_complete: complete,
      work_complete_at: complete ? new Date().toISOString() : null,
    })
    .eq("id", id)
  if (error) throw new Error(error.message)
  revalidatePath(`/projects/${project_id}/purchase-orders`)
}

export async function deletePurchaseOrder({
  id,
  project_id,
}: {
  id: string
  project_id: string
}) {
  await requireStaff()
  const supabase = await createSupabaseServerClient()
  const { data: cur, error: curErr } = await supabase
    .from("purchase_orders")
    .select("status")
    .eq("id", id)
    .maybeSingle()
  if (curErr) throw new Error(curErr.message)
  if (!cur) throw new Error("Purchase order not found")
  if (cur.status !== "draft") {
    throw new Error("Only draft POs can be deleted — void it instead.")
  }
  const { data: atts } = await supabase
    .from("po_attachments")
    .select("storage_path")
    .eq("purchase_order_id", id)
  const paths = (atts ?? []).map((a) => a.storage_path)
  // Re-assert draft on the delete itself — the pre-check can race with a
  // concurrent release, and a released PO must never be deleted.
  const { error, count } = await supabase
    .from("purchase_orders")
    .delete({ count: "exact" })
    .eq("id", id)
    .eq("status", "draft")
  if (error) throw new Error(error.message)
  if (!count) {
    throw new Error("Only draft POs can be deleted — void it instead.")
  }
  if (paths.length) {
    await supabase.storage.from("project-files").remove(paths)
  }
  revalidatePath(`/projects/${project_id}/purchase-orders`)
}

/** Staff reply on a PO's comment thread; emails the sub their link. */
export async function postPoCommentStaff({
  purchase_order_id,
  project_id,
  body,
}: {
  purchase_order_id: string
  project_id: string
  body: string
}) {
  const profile = await requireStaff()
  if (!body.trim()) throw new Error("Comment is empty")
  const supabase = await createSupabaseServerClient()
  const { error } = await supabase.from("po_comments").insert({
    purchase_order_id,
    author_profile_id: profile.id,
    author_name: profile.full_name ?? "Hines Homes",
    body: body.trim(),
  })
  if (error) throw new Error(error.message)

  const { data: po } = await supabase
    .from("purchase_orders")
    .select("number, title, token, companies:company_id(email, notifications_enabled)")
    .eq("id", purchase_order_id)
    .maybeSingle()
  const info = po as unknown as {
    number: number
    title: string
    token: string | null
    companies: { email: string | null; notifications_enabled: boolean } | null
  } | null
  if (info?.token && info.companies?.email && info.companies.notifications_enabled) {
    await sendEmail({
      to: [info.companies.email],
      subject: `New message on PO-${info.number}: ${info.title}`,
      text: `${profile.full_name ?? "Hines Homes"} wrote:\n\n${body.trim()}\n\nView and reply: ${appUrl(`/po/${info.token}`)}`,
    }).catch((e) => console.warn("[postPoCommentStaff] email failed:", e))
  }

  revalidatePath(`/projects/${project_id}/purchase-orders`)
}

export async function getSignedUrlsForPOs(paths: string[]) {
  await requireStaff()
  if (paths.length === 0) return {}
  const supabase = await createSupabaseServerClient()
  const { data, error } = await supabase.storage
    .from("project-files")
    .createSignedUrls(paths, 3600)
  if (error) throw new Error(error.message)
  const out: Record<string, string> = {}
  for (const d of data ?? []) {
    if (d.path && d.signedUrl) out[d.path] = d.signedUrl
  }
  return out
}

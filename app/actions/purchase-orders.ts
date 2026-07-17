"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { requireStaff } from "@/lib/auth"
import { sendEmail, appUrl } from "@/lib/email"
import { sendQuoSms, normalizeE164 } from "@/lib/quo"
import { isChannelEnabled } from "@/lib/notifications/preferences"
import { generateAccessToken } from "@/lib/tokens"
import { formatDate } from "@/lib/utils"
import { notifyCommentPosted } from "@/lib/comms/notify"
import { brandForProjectType } from "@/lib/brand"
import type { Enums } from "@/lib/db/types"

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
  // Set when the attachment LINKS a Files-tab document instead of a fresh
  // upload — the blob belongs to project_files and must never be removed
  // from Storage by attachment reconciliation.
  project_file_id: optStr,
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

// The PO list renders on both the legacy /purchase-orders route and the
// unified /purchasing page — revalidate both on every mutation.
function revalidatePoPaths(projectId: string) {
  revalidatePath(`/projects/${projectId}/purchase-orders`)
  revalidatePath(`/projects/${projectId}/purchasing`)
}

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
    .select("id, storage_path, project_file_id")
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
    // Only uploads owned by this PO get their blobs removed — a linked
    // Files-tab document's blob belongs to project_files, and removing it
    // would kill the file everywhere it's shown.
    const ownedPaths = toDelete
      .filter((d) => !d.project_file_id)
      .map((d) => d.storage_path)
    if (ownedPaths.length) {
      const { error: storageErr } = await supabase.storage
        .from("project-files")
        .remove(ownedPaths)
      if (storageErr) {
        console.warn("[savePurchaseOrder] storage cleanup failed (non-fatal):", storageErr.message)
      }
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
        project_file_id: nz(a.project_file_id),
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

  revalidatePoPaths(parsed.project_id)
  return { id }
}

/**
 * Copy a purchase order to another job (or duplicate within the same job).
 * The copy is always a fresh DRAFT: token, release/approval/decline/void
 * state and work-complete flags are all reset, and source_bid_recipient_id /
 * source_decision_id are dropped (provenance belongs to the original). Line items
 * + attachments carry over — cost codes and the vendor company are global
 * catalogs, so cost_code_id and company_id copy verbatim. po_comments are
 * NOT copied. Runs under the caller's session, so RLS limits the target to
 * projects the staffer can see.
 */
const CopyPurchaseOrderInput = z.object({
  id: z.string().uuid(),
  target_project_id: z.string().uuid(),
})

export async function copyPurchaseOrder(
  input: z.infer<typeof CopyPurchaseOrderInput>
) {
  const { id, target_project_id } = CopyPurchaseOrderInput.parse(input)
  const profile = await requireStaff()
  const supabase = await createSupabaseServerClient()

  const { data: src, error: srcErr } = await supabase
    .from("purchase_orders")
    .select("*")
    .eq("id", id)
    .maybeSingle()
  if (srcErr) throw new Error(srcErr.message)
  if (!src) throw new Error("Purchase order not found")

  const { data: targetProject, error: tgtErr } = await supabase
    .from("projects")
    .select("id")
    .eq("id", target_project_id)
    .maybeSingle()
  if (tgtErr) throw new Error(tgtErr.message)
  if (!targetProject) throw new Error("Target project not found.")

  const sameProject = src.project_id === target_project_id

  // Race-safe per-project number, same retry loop as savePurchaseOrder. The
  // insert omits every release/approval column so they take their draft
  // defaults (token null, status 'draft', etc.).
  let newId: string | null = null
  for (let attempt = 0; attempt < 5 && !newId; attempt++) {
    const { data: nextNum, error: rpcErr } = await supabase.rpc("next_po_number", {
      p_project: target_project_id,
    })
    if (rpcErr) throw new Error(rpcErr.message)
    const { data, error } = await supabase
      .from("purchase_orders")
      .insert({
        project_id: target_project_id,
        number: Number(nextNum),
        title: src.title,
        scope: src.scope,
        company_id: src.company_id,
        custom_number: src.custom_number,
        approval_deadline: src.approval_deadline,
        flat_fee: src.flat_fee,
        flat_total: src.flat_total,
        status: "draft",
        created_by: profile.id,
      })
      .select("id")
      .single()
    if (!error) {
      newId = data.id
      break
    }
    if (error.code !== "23505") throw new Error(error.message)
    await new Promise((r) => setTimeout(r, 25 + Math.random() * 50))
  }
  if (!newId) {
    throw new Error("Could not allocate a PO number after 5 attempts.")
  }

  // Line items — plain insert (nothing FKs them).
  const { data: srcLines } = await supabase
    .from("po_line_items")
    .select("*")
    .eq("purchase_order_id", id)
    .order("position", { ascending: true })
  if (srcLines?.length) {
    const { error: liErr } = await supabase.from("po_line_items").insert(
      srcLines.map((li) => ({
        purchase_order_id: newId!,
        cost_code_id: li.cost_code_id,
        description: li.description,
        quantity: li.quantity,
        unit: li.unit,
        unit_cost: li.unit_cost,
        position: li.position,
      }))
    )
    if (liErr) throw new Error(liErr.message)
  }

  // Attachments — an upload owned by the source PO gets its blob copied to
  // a fresh key under the target project. A LINKED Files-tab document is
  // different: same-project copies reuse the path + keep the link (the blob
  // belongs to project_files, so no duplicate is made); cross-project copies
  // blob-copy and DROP the link (the project_files row lives in the source
  // project). A failed blob copy is non-fatal.
  const { data: srcAtts } = await supabase
    .from("po_attachments")
    .select("*")
    .eq("purchase_order_id", id)
    .order("position", { ascending: true })
  for (const a of srcAtts ?? []) {
    if (a.project_file_id && sameProject) {
      const { error: aErr } = await supabase.from("po_attachments").insert({
        purchase_order_id: newId,
        storage_bucket: a.storage_bucket,
        storage_path: a.storage_path,
        file_name: a.file_name,
        file_type: a.file_type,
        file_size: a.file_size,
        caption: a.caption,
        project_file_id: a.project_file_id,
        position: a.position,
      })
      if (aErr) throw new Error(aErr.message)
      continue
    }
    const ext = a.file_name.split(".").pop()?.toLowerCase() ?? "bin"
    const newPath = `projects/${target_project_id}/purchase-orders/${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}.${ext}`
    const { error: copyErr } = await supabase.storage
      .from("project-files")
      .copy(a.storage_path, newPath)
    if (copyErr) {
      console.warn(
        "[copyPurchaseOrder] attachment blob copy failed (skipping):",
        copyErr.message
      )
      continue
    }
    const { error: aErr } = await supabase.from("po_attachments").insert({
      purchase_order_id: newId,
      storage_bucket: a.storage_bucket,
      storage_path: newPath,
      file_name: a.file_name,
      file_type: a.file_type,
      file_size: a.file_size,
      caption: a.caption,
      position: a.position,
    })
    if (aErr) {
      await supabase.storage.from("project-files").remove([newPath])
      throw new Error(aErr.message)
    }
  }

  revalidatePoPaths(target_project_id)
  if (!sameProject) revalidatePoPaths(src.project_id)
  return { id: newId, project_id: target_project_id, sameProject }
}

/**
 * Create a draft PO from an APPROVED selection/change order. Line items copy
 * the decision's cost breakdown — the approved choice's rows for selections,
 * the decision-level rows for change orders — at RAW unit_cost: markup_percent
 * is client-facing pricing and must never reach the sub. source_decision_id
 * records provenance (mirror of source_bid_recipient_id). Duplicates are a
 * soft warn, not a block: the return carries how many non-void POs already
 * point at this decision so the UI can mention it.
 */
const CreatePoFromDecisionInput = z.object({
  decision_id: z.string().uuid(),
  company_id: z.string().uuid(),
})

export async function createPoFromDecision(
  input: z.infer<typeof CreatePoFromDecisionInput>
) {
  const { decision_id, company_id } = CreatePoFromDecisionInput.parse(input)
  const profile = await requireStaff()
  const supabase = await createSupabaseServerClient()

  const { data: decision, error: dErr } = await supabase
    .from("decisions")
    .select("id, project_id, kind, number, title, description, status, selected_choice_id")
    .eq("id", decision_id)
    .maybeSingle()
  if (dErr) throw new Error(dErr.message)
  if (!decision) throw new Error("Decision not found")
  if (decision.status !== "approved") {
    throw new Error("Only an approved selection or change order can become a PO.")
  }

  const { data: company, error: cErr } = await supabase
    .from("companies")
    .select("id")
    .eq("id", company_id)
    .maybeSingle()
  if (cErr) throw new Error(cErr.message)
  if (!company) throw new Error("Company not found")

  let itemsQuery = supabase
    .from("decision_cost_items")
    .select("cost_code_id, description, quantity, unit, unit_cost, position")
    .eq("decision_id", decision_id)
    .order("position", { ascending: true })
  if (decision.kind === "selection") {
    if (!decision.selected_choice_id) {
      throw new Error("This selection has no approved option to build the PO from.")
    }
    itemsQuery = itemsQuery.eq("choice_id", decision.selected_choice_id)
  } else {
    itemsQuery = itemsQuery.is("choice_id", null)
  }
  const { data: items, error: iErr } = await itemsQuery
  if (iErr) throw new Error(iErr.message)

  const { data: priorPos, error: dupErr } = await supabase
    .from("purchase_orders")
    .select("id")
    .eq("source_decision_id", decision_id)
    .neq("status", "void")
  if (dupErr) throw new Error(dupErr.message)

  const kindLabel = decision.kind === "selection" ? "Selection" : "CO"
  const title = `${kindLabel} #${decision.number} — ${decision.title}`.slice(0, 300)

  // Race-safe per-project number, same retry loop as savePurchaseOrder.
  let newId: string | null = null
  for (let attempt = 0; attempt < 5 && !newId; attempt++) {
    const { data: nextNum, error: rpcErr } = await supabase.rpc("next_po_number", {
      p_project: decision.project_id,
    })
    if (rpcErr) throw new Error(rpcErr.message)
    const { data, error } = await supabase
      .from("purchase_orders")
      .insert({
        project_id: decision.project_id,
        number: Number(nextNum),
        title,
        scope: decision.description,
        company_id,
        flat_fee: false,
        status: "draft",
        source_decision_id: decision_id,
        created_by: profile.id,
      })
      .select("id")
      .single()
    if (!error) {
      newId = data.id
      break
    }
    if (error.code !== "23505") throw new Error(error.message)
    await new Promise((r) => setTimeout(r, 25 + Math.random() * 50))
  }
  if (!newId) {
    throw new Error("Could not allocate a PO number after 5 attempts.")
  }

  if (items?.length) {
    // decision_cost_items.description is nullable; po_line_items.description
    // is NOT NULL — fall back to the decision title.
    const { error } = await supabase.from("po_line_items").insert(
      items.map((li, i) => ({
        purchase_order_id: newId!,
        cost_code_id: li.cost_code_id,
        description: li.description?.trim() || decision.title,
        quantity: li.quantity,
        unit: li.unit,
        unit_cost: li.unit_cost,
        position: i,
      }))
    )
    if (error) throw new Error(error.message)
  }

  revalidatePoPaths(decision.project_id)
  return {
    id: newId,
    project_id: decision.project_id,
    already_linked: priorPos?.length ?? 0,
  }
}

/**
 * Create a draft PO for a bid recipient WITHOUT awarding the package — the
 * "sub never responded but we're moving ahead" path. Prefills title/scope/
 * flat-fee mode + line items from the package; pricing comes from the sub's
 * submitted quotes when they exist, otherwise 0 for staff to fill in. Stamps
 * source_bid_recipient_id for the same "From BID-N" chip as awarded POs, but
 * touches neither the package nor the recipient status — awarding stays the
 * sanctioned path for submitted bids.
 */
const CreatePoForBidRecipientInput = z.object({
  recipient_id: z.string().uuid(),
})

export async function createPoForBidRecipient(
  input: z.infer<typeof CreatePoForBidRecipientInput>
) {
  const { recipient_id } = CreatePoForBidRecipientInput.parse(input)
  const profile = await requireStaff()
  const supabase = await createSupabaseServerClient()

  const { data: recipient, error: rErr } = await supabase
    .from("bid_recipients")
    .select(
      "id, company_id, status, flat_total, bid_package_id, bid_packages:bid_package_id(id, project_id, number, title, scope, flat_fee)"
    )
    .eq("id", recipient_id)
    .maybeSingle()
  if (rErr) throw new Error(rErr.message)
  if (!recipient) throw new Error("Bid recipient not found")
  const pkg = (
    recipient as unknown as {
      bid_packages: {
        id: string
        project_id: string
        number: number
        title: string
        scope: string | null
        flat_fee: boolean
      } | null
    }
  ).bid_packages
  if (!pkg) throw new Error("Bid package not found")
  if (recipient.status === "awarded") {
    throw new Error("This bid was awarded — the award already created its PO.")
  }

  const { data: lines, error: lErr } = await supabase
    .from("bid_package_line_items")
    .select("id, cost_code_id, description, quantity, unit, position")
    .eq("bid_package_id", pkg.id)
    .order("position", { ascending: true })
  if (lErr) throw new Error(lErr.message)

  // Submitted quotes (if any) price the lines; missing quotes default to 0.
  const { data: quotes, error: qErr } = await supabase
    .from("bid_line_item_quotes")
    .select("line_item_id, unit_cost")
    .eq("bid_recipient_id", recipient_id)
  if (qErr) throw new Error(qErr.message)
  const quoteByLine = new Map((quotes ?? []).map((q) => [q.line_item_id, q.unit_cost]))

  let newId: string | null = null
  for (let attempt = 0; attempt < 5 && !newId; attempt++) {
    const { data: nextNum, error: rpcErr } = await supabase.rpc("next_po_number", {
      p_project: pkg.project_id,
    })
    if (rpcErr) throw new Error(rpcErr.message)
    const { data, error } = await supabase
      .from("purchase_orders")
      .insert({
        project_id: pkg.project_id,
        number: Number(nextNum),
        title: pkg.title,
        scope: pkg.scope,
        company_id: recipient.company_id,
        flat_fee: pkg.flat_fee,
        flat_total: pkg.flat_fee ? recipient.flat_total : null,
        status: "draft",
        source_bid_recipient_id: recipient_id,
        created_by: profile.id,
      })
      .select("id")
      .single()
    if (!error) {
      newId = data.id
      break
    }
    if (error.code !== "23505") throw new Error(error.message)
    await new Promise((r) => setTimeout(r, 25 + Math.random() * 50))
  }
  if (!newId) {
    throw new Error("Could not allocate a PO number after 5 attempts.")
  }

  if (!pkg.flat_fee && lines?.length) {
    const { error } = await supabase.from("po_line_items").insert(
      lines.map((li, i) => ({
        purchase_order_id: newId!,
        cost_code_id: li.cost_code_id,
        description: li.description,
        quantity: li.quantity,
        unit: li.unit,
        unit_cost: quoteByLine.get(li.id) ?? 0,
        position: i,
      }))
    )
    if (error) throw new Error(error.message)
  }

  revalidatePoPaths(pkg.project_id)
  return { id: newId, project_id: pkg.project_id }
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
  const profile = await requireStaff()
  const supabase = await createSupabaseServerClient()

  const { data: po, error: poErr } = await supabase
    .from("purchase_orders")
    .select(
      "id, number, title, approval_deadline, status, company_id, companies:company_id(name, email, phone, notifications_enabled), projects:project_id(name, project_type)"
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
  const project = (
    po as unknown as {
      projects: { name: string; project_type: Enums<"project_type"> | null } | null
    }
  ).projects
  const projectName = project?.name ?? "our project"
  // Client-/sub-facing brand for this job: commercial → MJV Building Group,
  // otherwise the default house brand (Hines Homes).
  const brand = brandForProjectType(project?.project_type)

  if (company?.notifications_enabled) {
    const link = appUrl(`/po/${token}`)
    const deadlineLine = po.approval_deadline
      ? ` Please review and approve by ${formatDate(po.approval_deadline)}.`
      : ""
    const log = {
      project_id,
      company_id: po.company_id,
      sent_by: profile.id,
      kind: "po_release",
      counterparty_name: company.name,
    }
    const sendJobs: Promise<unknown>[] = []
    if (
      company.email &&
      (await isChannelEnabled(
        supabase,
        { companyId: po.company_id },
        "bids_pos",
        "email"
      ))
    ) {
      sendJobs.push(
        sendEmail({
          to: [company.email],
          subject: `Purchase order PO-${po.number}: ${po.title} — ${projectName}`,
          text: `${brand.name} has issued you a purchase order for "${po.title}" on ${projectName}.${deadlineLine}\n\nReview and approve or decline here (no login needed):\n${link}`,
          fromName: brand.name,
          log,
        }).catch((e) => console.warn("[releasePurchaseOrder] email failed:", e))
      )
    }
    const e164 = company.phone ? normalizeE164(company.phone) : null
    if (
      e164 &&
      (await isChannelEnabled(
        supabase,
        { companyId: po.company_id },
        "bids_pos",
        "sms"
      ))
    ) {
      sendJobs.push(
        sendQuoSms({
          to: e164,
          content: `${brand.name} purchase order PO-${po.number} "${po.title}" on ${projectName}.${deadlineLine} Review & approve: ${link}`,
          log,
        }).catch((e) => console.warn("[releasePurchaseOrder] SMS failed:", e))
      )
    }
    await Promise.all(sendJobs)
  }

  revalidatePoPaths(project_id)
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
  revalidatePoPaths(project_id)
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
  revalidatePoPaths(project_id)
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
  revalidatePoPaths(project_id)
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
  revalidatePoPaths(project_id)
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
  // Re-assert draft on the delete itself — the pre-check can race with a
  // concurrent release, and a released PO must never be deleted.
  // Attachment Storage objects are NOT removed here: the delete is captured
  // into deleted_items (0088) so it can be restored from the History tab, and
  // the trash purge removes the objects when the entry expires unrestored.
  const { error, count } = await supabase
    .from("purchase_orders")
    .delete({ count: "exact" })
    .eq("id", id)
    .eq("status", "draft")
  if (error) throw new Error(error.message)
  if (!count) {
    throw new Error("Only draft POs can be deleted — void it instead.")
  }
  revalidatePoPaths(project_id)
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
    .select(
      "number, title, token, company_id, companies:company_id(name, email, notifications_enabled), projects:project_id(name, project_type)"
    )
    .eq("id", purchase_order_id)
    .maybeSingle()
  const info = po as unknown as {
    number: number
    title: string
    token: string | null
    company_id: string | null
    companies: {
      name: string
      email: string | null
      notifications_enabled: boolean
    } | null
    projects: { name: string; project_type: Enums<"project_type"> | null } | null
  } | null
  if (info?.token && info.companies?.email && info.companies.notifications_enabled) {
    const brand = brandForProjectType(info.projects?.project_type)
    await sendEmail({
      to: [info.companies.email],
      subject: `New message on PO-${info.number}: ${info.title}`,
      text: `${profile.full_name ?? brand.name} wrote:\n\n${body.trim()}\n\nView and reply: ${appUrl(`/po/${info.token}`)}`,
      fromName: brand.name,
      log: {
        project_id,
        company_id: info.company_id,
        sent_by: profile.id,
        kind: "po_comment_notify",
        counterparty_name: info.companies.name,
      },
    }).catch((e) => console.warn("[postPoCommentStaff] email failed:", e))
  }

  // Bell notification for the sub's trade logins.
  if (info?.company_id) {
    try {
      const { data: tradeProfiles } = await supabase
        .from("profiles")
        .select("id")
        .eq("company_id", info.company_id)
        .eq("role", "trade")
      await notifyCommentPosted({
        entityLabel: `PO-${info.number} — ${info.title}`,
        projectName: info.projects?.name ?? null,
        authorName: profile.full_name ?? "Hines Homes",
        authorIsStaff: true,
        authorProfileId: profile.id,
        body: body.trim(),
        staffLink: `/projects/${project_id}/purchase-orders?open=${purchase_order_id}`,
        counterpartyProfileIds: (tradeProfiles ?? []).map((p) => p.id),
        counterpartyLink: "/my-pos",
      })
    } catch (e) {
      console.warn("[postPoCommentStaff] notification failed:", e)
    }
  }

  revalidatePoPaths(project_id)
  revalidatePath(`/projects/${project_id}/communications`)
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

"use server"

// Public (tokenized, no-login) server actions for the /po/{token} page.
// Same security model as bid-public.ts: the URL token is the sub's only
// credential, all access goes through the service-role admin client (no anon
// RLS policies exist), tokens are shape-checked before any query, and every
// status change is a compare-and-swap on (token, status).

import { z } from "zod"
import { createSupabaseAdminClient } from "@/lib/supabase/admin"
import { ACCESS_TOKEN_RE } from "@/lib/tokens"
import { sendEmail, appUrl } from "@/lib/email"
import { notifyCommentPosted } from "@/lib/comms/notify"

const UNAVAILABLE =
  "This link is unavailable right now — please try again later."
const INVALID_LINK = "This link is not valid or has expired."

type AdminClient = NonNullable<ReturnType<typeof createSupabaseAdminClient>>

type PoCtx = {
  id: string
  number: number
  custom_number: string | null
  title: string
  status: "draft" | "released" | "approved" | "declined" | "void"
  project_id: string
  companies: { name: string } | null
  projects: { name: string; org_id: string | null } | null
}

function parseOrThrow<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input)
  if (!result.success) {
    const first = result.error.issues[0]
    throw new Error(first.message)
  }
  return result.data
}

/**
 * Shared guard: validate the token shape, get the admin client, and load the
 * PO with company + project context. Throws a friendly Error on every
 * failure mode.
 */
async function poForToken(token: string) {
  if (!ACCESS_TOKEN_RE.test(token)) throw new Error(INVALID_LINK)
  const admin = createSupabaseAdminClient()
  if (!admin) throw new Error(UNAVAILABLE)
  const { data, error } = await admin
    .from("purchase_orders")
    .select(
      `id, number, custom_number, title, status, project_id,
       companies:company_id(name),
       projects:project_id(name, org_id)`
    )
    .eq("token", token)
    .maybeSingle()
  if (error) {
    console.warn("[po-public] PO lookup failed:", error.message)
    throw new Error(UNAVAILABLE)
  }
  if (!data) throw new Error(INVALID_LINK)
  const po = data as unknown as PoCtx
  return { admin, po }
}

/** Same staff fan-out pattern as bid-public.ts: in-app rows + one email.
 * Recipients are limited to staff who belong to the PO's org — the admin
 * client bypasses org RLS, so an unscoped all-staff query would notify every
 * tenant. A missing org fails CLOSED to nobody. */
async function notifyStaff(
  admin: AdminClient,
  orgId: string | null,
  opts: {
    type: string
    title: string
    body: string
    linkUrl: string
    emailSubject: string
    emailText: string
  }
) {
  if (!orgId) {
    console.warn("[po-public] no org for PO — skipping staff fan-out")
    return
  }
  const { data: staff, error } = await admin
    .from("profiles")
    .select("id, email, notifications_enabled, organization_members!inner(org_id)")
    .eq("role", "staff")
    .eq("organization_members.org_id", orgId)
  if (error) {
    console.warn("[po-public] staff lookup failed:", error.message)
    return
  }
  const rows = (staff ?? []).map((p) => ({
    recipient_id: p.id,
    type: opts.type,
    title: opts.title,
    body: opts.body,
    link_url: opts.linkUrl,
  }))
  if (rows.length) {
    const { error: nErr } = await admin.from("notifications").insert(rows)
    if (nErr) console.warn("[po-public] notifications insert failed:", nErr.message)
  }
  const emails = (staff ?? [])
    .filter((p) => p.notifications_enabled && p.email)
    .map((p) => p.email as string)
  if (emails.length) {
    await sendEmail({
      to: emails,
      subject: opts.emailSubject,
      text: opts.emailText,
    })
  }
}

const ApproveInput = z.object({
  token: z.string(),
  signature_name: z
    .string()
    .trim()
    .min(2, "Type your full name as your signature.")
    .max(200, "Signature is too long."),
  disclaimer_accepted: z.literal(true, {
    error: "Check the box to confirm you agree.",
  }),
})

/**
 * Sub approves the PO with a typed signature. approved_by_profile_id stays
 * null — that's how staff-entered approvals stay distinguishable from
 * sub-signed ones. CAS released → approved.
 */
export async function approvePoByToken(input: {
  token: string
  signature_name: string
  disclaimer_accepted: boolean
}) {
  const parsed = parseOrThrow(ApproveInput, input)
  const { admin, po } = await poForToken(parsed.token)
  if (po.status !== "released") {
    throw new Error("This purchase order can no longer be approved — refresh the page to see its current status.")
  }

  const { error, count } = await admin
    .from("purchase_orders")
    .update(
      {
        status: "approved",
        approved_at: new Date().toISOString(),
        approved_signature: parsed.signature_name,
      },
      { count: "exact" }
    )
    .eq("token", parsed.token)
    .eq("status", "released")
  if (error) throw new Error("Could not record your approval — please try again.")
  if (!count) {
    throw new Error("This purchase order could not be approved — it may have been updated or revoked. Refresh the page.")
  }

  try {
    const companyName = po.companies?.name ?? "The subcontractor"
    const projectName = po.projects?.name ?? "a project"
    await notifyStaff(admin, po.projects?.org_id ?? null, {
      type: "po_approved",
      title: `PO approved: PO-${po.number} ${po.title}`,
      body: `${companyName} approved with signature`,
      linkUrl: `/projects/${po.project_id}/purchase-orders`,
      emailSubject: `PO approved: PO-${po.number} ${po.title} — ${projectName}`,
      emailText: `${companyName} approved purchase order PO-${po.number} "${po.title}" on ${projectName}.\n\nSigned: ${parsed.signature_name}\n\nView it here: ${appUrl(`/projects/${po.project_id}/purchase-orders`)}`,
    })
  } catch (e) {
    console.warn("[approvePoByToken] staff notify failed (non-fatal):", e)
  }

  return { ok: true as const }
}

const DeclineInput = z.object({
  token: z.string(),
  reason: z
    .string()
    .trim()
    .min(2, "Tell us why you're declining.")
    .max(2000, "Reason is too long."),
})

/**
 * Sub declines the PO. A reason is required so staff know what to fix.
 * CAS released → declined.
 */
export async function declinePoByToken(input: { token: string; reason: string }) {
  const parsed = parseOrThrow(DeclineInput, input)
  const { admin, po } = await poForToken(parsed.token)
  if (po.status !== "released") {
    throw new Error("This purchase order can no longer be declined — refresh the page to see its current status.")
  }

  const { error, count } = await admin
    .from("purchase_orders")
    .update(
      {
        status: "declined",
        declined_at: new Date().toISOString(),
        decline_reason: parsed.reason,
      },
      { count: "exact" }
    )
    .eq("token", parsed.token)
    .eq("status", "released")
  if (error) throw new Error("Could not record your response — please try again.")
  if (!count) {
    throw new Error("This purchase order could not be declined — it may have been updated or revoked. Refresh the page.")
  }

  try {
    const companyName = po.companies?.name ?? "The subcontractor"
    const projectName = po.projects?.name ?? "a project"
    await notifyStaff(admin, po.projects?.org_id ?? null, {
      type: "po_declined",
      title: `PO declined: PO-${po.number} ${po.title}`,
      body: `${companyName} declined the purchase order`,
      linkUrl: `/projects/${po.project_id}/purchase-orders`,
      emailSubject: `PO declined: PO-${po.number} ${po.title} — ${projectName}`,
      emailText: `${companyName} declined purchase order PO-${po.number} "${po.title}" on ${projectName}.\n\nReason: ${parsed.reason}\n\nView it here: ${appUrl(`/projects/${po.project_id}/purchase-orders`)}`,
    })
  } catch (e) {
    console.warn("[declinePoByToken] staff notify failed (non-fatal):", e)
  }

  return { ok: true as const }
}

const CommentInput = z.object({
  token: z.string(),
  body: z.string().min(1, "Write a message first.").max(5000),
})

/**
 * Sub posts a question/comment on the PO thread. author_profile_id stays
 * null (token-page author); author_name snapshots the company name.
 */
export async function postPoCommentPublic(input: { token: string; body: string }) {
  const parsed = parseOrThrow(CommentInput, input)
  const { admin, po } = await poForToken(parsed.token)

  const companyName = po.companies?.name ?? "Subcontractor"
  const { error } = await admin.from("po_comments").insert({
    purchase_order_id: po.id,
    author_profile_id: null,
    author_name: companyName,
    body: parsed.body.trim(),
  })
  if (error) throw new Error("Could not post your message — please try again.")

  const staffLink = `/projects/${po.project_id}/purchase-orders?open=${po.id}`
  try {
    const { data: staff } = await admin
      .from("profiles")
      .select("email, notifications_enabled")
      .eq("role", "staff")
      .eq("notifications_enabled", true)
    const emails = (staff ?? [])
      .map((p) => p.email)
      .filter((e): e is string => !!e)
    if (emails.length) {
      await sendEmail({
        to: emails,
        subject: `New PO question from ${companyName}`,
        text: `${companyName} wrote on PO-${po.number} "${po.title}":\n\n${parsed.body.trim()}\n\nReply here: ${appUrl(staffLink)}`,
      })
    }
  } catch (e) {
    console.warn("[postPoCommentPublic] staff email failed (non-fatal):", e)
  }
  // Bell notifications for staff (in-app bell + Communications feed).
  await notifyCommentPosted({
    entityLabel: `PO-${po.number} — ${po.title}`,
    authorName: companyName,
    authorIsStaff: false,
    body: parsed.body.trim(),
    staffLink,
    projectId: po.project_id,
  })

  return { ok: true as const }
}

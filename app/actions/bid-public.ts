"use server"

// Public (tokenized, no-login) server actions for the /bid/{token} page.
// The 43-char token in the URL is the sub's only credential, so:
//   * NO auth imports — these run for anonymous visitors.
//   * ALL data access goes through the service-role admin client (there are
//     no anon RLS policies on bid tables by design).
//   * Tokens are shape-checked with ACCESS_TOKEN_RE before ever touching the
//     DB, and every status change is a compare-and-swap on (token, status)
//     so a revoked link or a double-click can never clobber state.
//   * Nothing here ever exposes another recipient's data.

import { z } from "zod"
import { createSupabaseAdminClient } from "@/lib/supabase/admin"
import { ACCESS_TOKEN_RE } from "@/lib/tokens"
import { sendEmail, appUrl } from "@/lib/email"
import { formatCurrency } from "@/lib/utils"
import { notifyCommentPosted } from "@/lib/comms/notify"

const UNAVAILABLE =
  "This link is unavailable right now — please try again later."
const INVALID_LINK = "This link is not valid or has expired."

type AdminClient = NonNullable<ReturnType<typeof createSupabaseAdminClient>>

type RecipientCtx = {
  id: string
  status: "invited" | "submitted" | "declined" | "awarded"
  notes: string | null
  flat_total: number | null
  bid_packages: {
    id: string
    project_id: string
    title: string
    status: "draft" | "sent" | "awarded" | "closed"
    flat_fee: boolean
    projects: { name: string; org_id: string | null } | null
  } | null
  companies: { name: string } | null
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
 * Shared guard: validate the token shape, get the admin client, and load
 * the recipient (with package + project + company context). Throws a
 * friendly Error for every failure mode — callers just let it propagate.
 */
async function recipientForToken(token: string) {
  if (!ACCESS_TOKEN_RE.test(token)) throw new Error(INVALID_LINK)
  const admin = createSupabaseAdminClient()
  if (!admin) throw new Error(UNAVAILABLE)
  const { data, error } = await admin
    .from("bid_recipients")
    .select(
      `id, status, notes, flat_total,
       bid_packages:bid_package_id(id, project_id, title, status, flat_fee,
         projects:project_id(name, org_id)),
       companies:company_id(name)`
    )
    .eq("token", token)
    .maybeSingle()
  if (error) {
    console.warn("[bid-public] recipient lookup failed:", error.message)
    throw new Error(UNAVAILABLE)
  }
  if (!data) throw new Error(INVALID_LINK)
  const rec = data as unknown as RecipientCtx
  if (!rec.bid_packages) throw new Error(INVALID_LINK)
  return { admin, rec, pkg: rec.bid_packages }
}

/**
 * Staff fan-out after a sub acts: in-app notification rows for every staff
 * profile + one email to staff who have notifications enabled. Best-effort —
 * callers wrap this in try/catch so a notify hiccup never fails the action.
 */
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
  // Only staff in the package's org — the admin client bypasses org RLS, so
  // an unscoped all-staff query would notify every tenant. A missing org
  // fails CLOSED to nobody.
  if (!orgId) {
    console.warn("[bid-public] no org for package — skipping staff fan-out")
    return
  }
  const { data: staff, error } = await admin
    .from("profiles")
    .select("id, email, notifications_enabled, organization_members!inner(org_id)")
    .eq("role", "staff")
    .eq("organization_members.org_id", orgId)
  if (error) {
    console.warn("[bid-public] staff lookup failed:", error.message)
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
    if (nErr) console.warn("[bid-public] notifications insert failed:", nErr.message)
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

/**
 * Upsert the recipient's quotes, restricted to line items that actually
 * belong to their package (a hostile payload can't attach quotes to some
 * other package's lines). Unique (bid_recipient_id, line_item_id) makes the
 * upsert idempotent.
 */
async function persistQuotes(
  admin: AdminClient,
  recipientId: string,
  packageId: string,
  quotes: { line_item_id: string; unit_cost: number }[]
) {
  if (!quotes.length) return
  const { data: lineItems, error } = await admin
    .from("bid_package_line_items")
    .select("id")
    .eq("bid_package_id", packageId)
  if (error) throw new Error("Could not save your pricing — please try again.")
  const valid = new Set((lineItems ?? []).map((li) => li.id))
  // Dedupe by line item (last one wins) — a repeated line_item_id would make
  // the batch upsert fail with "cannot affect row a second time".
  const byLine = new Map<string, number>()
  for (const q of quotes) {
    if (valid.has(q.line_item_id)) byLine.set(q.line_item_id, q.unit_cost)
  }
  const rows = [...byLine.entries()].map(([line_item_id, unit_cost]) => ({
    bid_recipient_id: recipientId,
    line_item_id,
    unit_cost,
  }))
  if (!rows.length) return
  const { error: upErr } = await admin
    .from("bid_line_item_quotes")
    .upsert(rows, { onConflict: "bid_recipient_id,line_item_id" })
  if (upErr) throw new Error("Could not save your pricing — please try again.")
}

const Quote = z.object({
  line_item_id: z.string().min(1),
  unit_cost: z.coerce.number().nonnegative(),
})

const ResponseInput = z.object({
  token: z.string(),
  quotes: z.array(Quote).default([]),
  flat_total: z.coerce.number().nonnegative().nullish(),
  notes: z.string().max(5000).nullish(),
})

/**
 * Save pricing/notes without submitting ("save for later"). Only possible
 * while the recipient is still `invited` and the package is open.
 */
export async function saveBidDraft(input: {
  token: string
  quotes?: { line_item_id: string; unit_cost: number | string }[]
  flat_total?: number | string | null
  notes?: string | null
}) {
  const parsed = parseOrThrow(ResponseInput, input)
  const { admin, rec, pkg } = await recipientForToken(parsed.token)
  if (rec.status !== "invited") {
    throw new Error("This bid has already been responded to and can no longer be edited.")
  }
  if (pkg.status === "closed") throw new Error("Bidding on this package has closed.")

  if (!pkg.flat_fee) {
    await persistQuotes(admin, rec.id, pkg.id, parsed.quotes)
  }
  const { error, count } = await admin
    .from("bid_recipients")
    .update(
      {
        notes: parsed.notes?.trim() || null,
        ...(pkg.flat_fee ? { flat_total: parsed.flat_total ?? null } : {}),
      },
      { count: "exact" }
    )
    .eq("token", parsed.token)
    .eq("status", "invited")
  if (error) throw new Error("Could not save your draft — please try again.")
  if (!count) {
    throw new Error("This bid could not be saved — the link may have been revoked. Refresh the page.")
  }
  return { ok: true as const }
}

/**
 * Submit the bid: validate completeness, persist quotes, compute the
 * denormalized total, and compare-and-swap invited → submitted. Staff get
 * in-app notifications + email afterward (best-effort).
 */
export async function submitBidResponse(input: {
  token: string
  quotes?: { line_item_id: string; unit_cost: number | string }[]
  flat_total?: number | string | null
  notes?: string | null
}) {
  const parsed = parseOrThrow(ResponseInput, input)
  const { admin, rec, pkg } = await recipientForToken(parsed.token)
  if (rec.status !== "invited") {
    throw new Error("This bid has already been responded to.")
  }
  if (pkg.status === "closed") throw new Error("Bidding on this package has closed.")

  let total: number
  if (pkg.flat_fee) {
    if (parsed.flat_total == null) {
      throw new Error("Enter your total price before submitting.")
    }
    total = parsed.flat_total
  } else {
    const { data: lineItems, error: liErr } = await admin
      .from("bid_package_line_items")
      .select("id, quantity")
      .eq("bid_package_id", pkg.id)
    if (liErr) throw new Error("Could not load the bid line items — please try again.")
    const quoteByLine = new Map(
      parsed.quotes.map((q) => [q.line_item_id, q.unit_cost])
    )
    const missing = (lineItems ?? []).filter((li) => !quoteByLine.has(li.id))
    if (missing.length) {
      throw new Error("Enter a price for every line item before submitting.")
    }
    await persistQuotes(admin, rec.id, pkg.id, parsed.quotes)
    total = (lineItems ?? []).reduce(
      (sum, li) => sum + (quoteByLine.get(li.id) ?? 0) * Number(li.quantity),
      0
    )
  }
  total = Math.round(total * 100) / 100

  const { error, count } = await admin
    .from("bid_recipients")
    .update(
      {
        status: "submitted",
        submitted_at: new Date().toISOString(),
        flat_total: total,
        notes: parsed.notes?.trim() || null,
      },
      { count: "exact" }
    )
    .eq("token", parsed.token)
    .eq("status", "invited")
  if (error) throw new Error("Could not submit your bid — please try again.")
  if (!count) {
    throw new Error("This bid could not be submitted — it may already have been submitted or the link was revoked. Refresh the page.")
  }

  try {
    const companyName = rec.companies?.name ?? "A subcontractor"
    const projectName = pkg.projects?.name ?? "a project"
    await notifyStaff(admin, pkg.projects?.org_id ?? null, {
      type: "bid_submitted",
      title: `Bid received: ${pkg.title}`,
      body: `${companyName} submitted a bid`,
      linkUrl: `/projects/${pkg.project_id}/bids`,
      emailSubject: `Bid received: ${pkg.title} — ${projectName}`,
      emailText: `${companyName} submitted a bid of ${formatCurrency(total)} for "${pkg.title}" on ${projectName}.\n\nReview it here: ${appUrl(`/projects/${pkg.project_id}/bids`)}`,
    })
  } catch (e) {
    console.warn("[submitBidResponse] staff notify failed (non-fatal):", e)
  }

  return { ok: true as const }
}

const DeclineInput = z.object({
  token: z.string(),
  reason: z.string().max(2000).nullish(),
})

/**
 * Decline to bid (allowed any time before submitting, including after a
 * save-for-later). Optional reason is appended to the recipient's notes so
 * staff see it in the comparison view.
 */
export async function declineBid(input: { token: string; reason?: string | null }) {
  const parsed = parseOrThrow(DeclineInput, input)
  const { admin, rec, pkg } = await recipientForToken(parsed.token)
  if (rec.status !== "invited") {
    throw new Error("This bid has already been responded to.")
  }

  const reason = parsed.reason?.trim()
  const notes = reason
    ? rec.notes
      ? `${rec.notes}\n\nDeclined: ${reason}`
      : `Declined: ${reason}`
    : rec.notes

  const { error, count } = await admin
    .from("bid_recipients")
    .update({ status: "declined", notes }, { count: "exact" })
    .eq("token", parsed.token)
    .eq("status", "invited")
  if (error) throw new Error("Could not record your response — please try again.")
  if (!count) {
    throw new Error("This bid could not be declined — it may already have been responded to or the link was revoked. Refresh the page.")
  }

  try {
    const companyName = rec.companies?.name ?? "A subcontractor"
    const projectName = pkg.projects?.name ?? "a project"
    await notifyStaff(admin, pkg.projects?.org_id ?? null, {
      type: "bid_declined",
      title: `Bid declined: ${pkg.title}`,
      body: `${companyName} declined to bid`,
      linkUrl: `/projects/${pkg.project_id}/bids`,
      emailSubject: `Bid declined: ${pkg.title} — ${projectName}`,
      emailText: `${companyName} declined to bid on "${pkg.title}" at ${projectName}.${reason ? `\n\nReason: ${reason}` : ""}\n\nView the package: ${appUrl(`/projects/${pkg.project_id}/bids`)}`,
    })
  } catch (e) {
    console.warn("[declineBid] staff notify failed (non-fatal):", e)
  }

  return { ok: true as const }
}

const CommentInput = z.object({
  token: z.string(),
  body: z.string().min(1, "Write a message first.").max(5000),
})

/**
 * Sub posts a question/comment on their private thread. author_profile_id
 * stays null (token-page author); author_name snapshots the company name.
 */
export async function postBidCommentPublic(input: { token: string; body: string }) {
  const parsed = parseOrThrow(CommentInput, input)
  const { admin, rec, pkg } = await recipientForToken(parsed.token)
  if (pkg.status === "closed") throw new Error("Bidding on this package has closed.")

  const companyName = rec.companies?.name ?? "Subcontractor"
  const { error } = await admin.from("bid_comments").insert({
    bid_recipient_id: rec.id,
    author_profile_id: null,
    author_name: companyName,
    body: parsed.body.trim(),
  })
  if (error) throw new Error("Could not post your message — please try again.")

  const staffLink = `/projects/${pkg.project_id}/bids?open=${pkg.id}&recipient=${rec.id}`
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
        subject: `New bid question from ${companyName}`,
        text: `${companyName} wrote on "${pkg.title}":\n\n${parsed.body.trim()}\n\nReply here: ${appUrl(staffLink)}`,
      })
    }
  } catch (e) {
    console.warn("[postBidCommentPublic] staff email failed (non-fatal):", e)
  }
  // Bell notifications for staff (the email above reaches inboxes; this
  // makes the comment land in the in-app bell + Communications feed too).
  await notifyCommentPosted({
    entityLabel: `Bid — ${pkg.title}`,
    projectName: pkg.projects?.name ?? null,
    authorName: companyName,
    authorIsStaff: false,
    body: parsed.body.trim(),
    staffLink,
    projectId: pkg.project_id,
  })

  return { ok: true as const }
}

/**
 * Stamp viewed_at the first time the sub opens their link. Fire-and-forget:
 * never throws — a tracking failure must not break the page.
 */
export async function markBidViewed(input: { token: string }) {
  try {
    if (!ACCESS_TOKEN_RE.test(input.token)) return { ok: false as const }
    const admin = createSupabaseAdminClient()
    if (!admin) return { ok: false as const }
    await admin
      .from("bid_recipients")
      .update({ viewed_at: new Date().toISOString() })
      .eq("token", input.token)
      .is("viewed_at", null)
    return { ok: true as const }
  } catch {
    return { ok: false as const }
  }
}

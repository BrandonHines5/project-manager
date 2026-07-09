import type { Metadata } from "next"
import { cache } from "react"
import { notFound } from "next/navigation"
import { createSupabaseAdminClient } from "@/lib/supabase/admin"
import { ACCESS_TOKEN_RE } from "@/lib/tokens"
import { brandForProjectType, HINES_HOMES } from "@/lib/brand"
import { appUrl } from "@/lib/email"
import type { Enums } from "@/lib/db/types"
import { Badge } from "@/components/ui/badge"
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card"
import { formatCurrency, formatDate } from "@/lib/utils"
import { PoApprovalForm } from "./po-approval-form"

// Public tokenized page — outside the (app) group, so no auth shell. The
// token is the credential; all reads use the service-role client because
// PO tables have no anon RLS policies.
export const dynamic = "force-dynamic"

// One DB read per request, shared by generateMetadata and the page body via
// React's request-scoped cache(): both run in the same request, so the PO row
// is fetched once. Uses the full projection so the page body reads from the
// same memoized promise instead of re-querying; generateMetadata just needs
// project_type off it. Service-role client because PO tables have no anon RLS.
const loadPurchaseOrder = cache(async (token: string) => {
  const admin = createSupabaseAdminClient()
  if (!admin) return { admin: null, data: null, error: null }
  const { data, error } = await admin
    .from("purchase_orders")
    .select(
      `id, number, custom_number, title, scope, status, approval_deadline,
       flat_fee, flat_total, approved_at, approved_signature, declined_at,
       decline_reason, project_id,
       projects:project_id(name, project_type),
       companies:company_id(name),
       po_line_items(id, description, quantity, unit, unit_cost, position,
         cost_codes:cost_code_id(code, name)),
       po_attachments(id, file_name, storage_path, caption, position),
       po_comments(id, author_name, author_profile_id, body, created_at)`
    )
    .eq("token", token)
    .maybeSingle()
  return { admin, data, error }
})

// Brand the link preview (title + favicon + og:image) by the PO's job type,
// so an MJV job's approval link texted to a sub previews as MJV — not the
// app's default Hines favicon. Any miss falls back to the default house brand
// rather than leaking that the token is invalid.
export async function generateMetadata({
  params,
}: {
  params: Promise<{ token: string }>
}): Promise<Metadata> {
  const { token } = await params
  let brand = HINES_HOMES
  if (ACCESS_TOKEN_RE.test(token)) {
    const { data } = await loadPurchaseOrder(token)
    const projectType = (
      data as unknown as {
        projects: { project_type: Enums<"project_type"> | null } | null
      } | null
    )?.projects?.project_type
    brand = brandForProjectType(projectType)
  }
  const title = `Purchase order — ${brand.name}`
  const image = appUrl(brand.icon)
  return {
    title,
    robots: { index: false },
    icons: { icon: brand.icon, shortcut: brand.icon, apple: brand.icon },
    openGraph: {
      title,
      siteName: brand.name,
      type: "website",
      images: [{ url: image }],
    },
    twitter: { card: "summary", title, images: [image] },
  }
}

type PageData = {
  id: string
  number: number
  custom_number: string | null
  title: string
  scope: string | null
  status: "draft" | "released" | "approved" | "declined" | "void"
  approval_deadline: string | null
  flat_fee: boolean
  flat_total: number | null
  approved_at: string | null
  approved_signature: string | null
  declined_at: string | null
  decline_reason: string | null
  project_id: string
  projects: { name: string; project_type: Enums<"project_type"> | null } | null
  companies: { name: string } | null
  po_line_items: {
    id: string
    description: string
    quantity: number
    unit: string | null
    unit_cost: number
    position: number
    cost_codes: { code: string; name: string } | null
  }[]
  po_attachments: {
    id: string
    file_name: string
    storage_path: string
    caption: string | null
    position: number
  }[]
  po_comments: {
    id: string
    author_name: string
    author_profile_id: string | null
    body: string
    created_at: string
  }[]
}

function Shell({
  brandName,
  children,
}: {
  brandName: string
  children: React.ReactNode
}) {
  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-2xl mx-auto p-4 flex flex-col gap-4">
        <header className="pt-2">
          <span className="text-lg font-semibold tracking-tight text-brand-700">
            {brandName}
          </span>
        </header>
        {children}
      </div>
    </div>
  )
}

function Unavailable() {
  return (
    <Shell brandName="Hines Homes">
      <Card>
        <CardBody className="text-center py-10">
          <p className="text-sm text-muted">
            This link is unavailable right now — please try again later.
          </p>
        </CardBody>
      </Card>
    </Shell>
  )
}

export default async function PoTokenPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params
  if (!ACCESS_TOKEN_RE.test(token)) notFound()

  const { admin, data, error } = await loadPurchaseOrder(token)
  if (!admin) return <Unavailable />
  if (error) {
    console.warn("[po page] lookup failed:", error.message)
    return <Unavailable />
  }
  if (!data) notFound()

  const po = data as unknown as PageData
  const brand = brandForProjectType(po.projects?.project_type)
  const projectName = po.projects?.name ?? "our project"
  const poLabel = po.custom_number
    ? `PO-${po.number} (${po.custom_number})`
    : `PO-${po.number}`

  // A voided PO shows the notice and nothing else actionable.
  if (po.status === "void") {
    return (
      <Shell brandName={brand.name}>
        <Card>
          <CardHeader>
            <p className="text-xs text-muted uppercase tracking-wide">
              {poLabel} — {projectName}
            </p>
            <CardTitle className="text-lg">{po.title}</CardTitle>
          </CardHeader>
          <CardBody>
            <p className="text-sm text-muted">This purchase order was voided.</p>
          </CardBody>
        </Card>
      </Shell>
    )
  }

  const lineItems = [...po.po_line_items].sort((a, b) => a.position - b.position)
  const attachments = [...po.po_attachments].sort((a, b) => a.position - b.position)
  const comments = [...po.po_comments].sort((a, b) =>
    a.created_at.localeCompare(b.created_at)
  )

  const total = po.flat_fee
    ? po.flat_total
    : lineItems.reduce(
        (sum, li) => sum + Number(li.quantity) * Number(li.unit_cost),
        0
      )

  const signed: Record<string, string> = {}
  if (attachments.length) {
    const { data: urls } = await admin.storage
      .from("project-files")
      .createSignedUrls(attachments.map((a) => a.storage_path), 3600)
    for (const u of urls ?? []) {
      if (u.path && u.signedUrl) signed[u.path] = u.signedUrl
    }
  }

  return (
    <Shell brandName={brand.name}>
      <Card>
        <CardHeader>
          <div className="flex flex-col gap-1">
            <p className="text-xs text-muted uppercase tracking-wide">
              Purchase order {poLabel} — {projectName}
            </p>
            <CardTitle className="text-lg">{po.title}</CardTitle>
            <div className="flex flex-wrap items-center gap-2 pt-1">
              {po.companies?.name && <Badge tone="neutral">{po.companies.name}</Badge>}
              {po.approval_deadline && po.status === "released" && (
                <Badge tone="warning">
                  Approve by {formatDate(po.approval_deadline)}
                </Badge>
              )}
            </div>
          </div>
        </CardHeader>

        {po.status === "approved" && (
          <div className="mx-5 mt-4 rounded-md border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-900">
            Approved by {po.approved_signature ?? "signature on file"} on{" "}
            {formatDate(po.approved_at)}.
          </div>
        )}
        {po.status === "declined" && (
          <div className="mx-5 mt-4 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">
            You declined this purchase order
            {po.declined_at ? ` on ${formatDate(po.declined_at)}` : ""}.
            {po.decline_reason ? ` Reason: ${po.decline_reason}` : ""}
          </div>
        )}

        <CardBody className="flex flex-col gap-4">
          {po.scope && (
            <div>
              <h2 className="text-xs font-medium text-muted uppercase tracking-wide mb-1">
                Scope of work
              </h2>
              <p className="text-sm whitespace-pre-wrap">{po.scope}</p>
            </div>
          )}

          {po.flat_fee ? (
            <p className="text-sm">
              Contract amount:{" "}
              <span className="font-semibold tabular-nums">
                {formatCurrency(total)}
              </span>
            </p>
          ) : (
            <div className="overflow-x-auto -mx-5 px-5">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted uppercase tracking-wide border-b border-border">
                    <th className="py-2 pr-3 font-medium">Item</th>
                    <th className="py-2 pr-3 font-medium text-right">Qty</th>
                    <th className="py-2 pr-3 font-medium text-right">Unit cost</th>
                    <th className="py-2 font-medium text-right">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {lineItems.map((li) => (
                    <tr key={li.id} className="border-b border-border last:border-0">
                      <td className="py-2 pr-3 align-top">
                        <div>{li.description}</div>
                        {li.cost_codes && (
                          <div className="text-xs text-muted">
                            {li.cost_codes.code} {li.cost_codes.name}
                          </div>
                        )}
                      </td>
                      <td className="py-2 pr-3 text-right align-top tabular-nums whitespace-nowrap">
                        {Number(li.quantity)}
                        {li.unit ? ` ${li.unit}` : ""}
                      </td>
                      <td className="py-2 pr-3 text-right align-top tabular-nums">
                        {formatCurrency(Number(li.unit_cost))}
                      </td>
                      <td className="py-2 text-right align-top tabular-nums">
                        {formatCurrency(Number(li.quantity) * Number(li.unit_cost))}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={3} className="py-2 pr-3 text-right font-medium">
                      Total
                    </td>
                    <td className="py-2 text-right font-semibold tabular-nums">
                      {formatCurrency(total)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}

          {attachments.length > 0 && (
            <div>
              <h2 className="text-xs font-medium text-muted uppercase tracking-wide mb-1">
                Attachments
              </h2>
              <ul className="flex flex-col gap-1">
                {attachments.map((a) => (
                  <li key={a.id}>
                    {signed[a.storage_path] ? (
                      <a
                        href={signed[a.storage_path]}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm text-brand-600 underline underline-offset-2 break-all"
                      >
                        {a.file_name}
                      </a>
                    ) : (
                      <span className="text-sm text-muted">{a.file_name}</span>
                    )}
                    {a.caption && (
                      <span className="text-xs text-muted"> — {a.caption}</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </CardBody>
      </Card>

      <PoApprovalForm
        token={token}
        active={po.status === "released"}
        comments={comments.map((c) => ({
          id: c.id,
          author_name: c.author_name,
          fromBuilder: c.author_profile_id != null,
          body: c.body,
          created_at: c.created_at,
        }))}
      />

      <p className="text-center text-xs text-muted pb-6">
        Questions? Use the message thread above and we&apos;ll get back to you.
      </p>
    </Shell>
  )
}

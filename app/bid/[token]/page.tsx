import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { createSupabaseAdminClient } from "@/lib/supabase/admin"
import { ACCESS_TOKEN_RE } from "@/lib/tokens"
import { brandForProjectType } from "@/lib/brand"
import { getBrandConfig } from "@/lib/org-brand"
import type { Enums } from "@/lib/db/types"
import { Badge } from "@/components/ui/badge"
import { ScopeText } from "@/components/purchasing/scope-text"
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card"
import { formatDate } from "@/lib/utils"
import { BidResponseForm } from "./bid-response-form"

// Public tokenized page — lives outside the (app) group, so no auth shell.
// The token in the URL is the credential; everything is fetched with the
// service-role client because bid tables have no anon RLS policies.
export const dynamic = "force-dynamic"

export const metadata: Metadata = {
  title: "Bid request — BuildFox",
  robots: { index: false },
}

type PageData = {
  id: string
  status: "invited" | "submitted" | "declined" | "awarded"
  flat_total: number | null
  notes: string | null
  viewed_at: string | null
  submitted_at: string | null
  companies: { name: string } | null
  bid_packages: {
    id: string
    project_id: string
    number: number
    title: string
    scope: string | null
    due_date: string | null
    status: "draft" | "sent" | "awarded" | "closed"
    flat_fee: boolean
    projects: {
      name: string
      project_type: Enums<"project_type"> | null
      org_id: string
    } | null
    bid_package_line_items: {
      id: string
      description: string
      quantity: number
      unit: string | null
      position: number
      cost_codes: { code: string; name: string } | null
    }[]
    bid_package_attachments: {
      id: string
      file_name: string
      storage_path: string
      caption: string | null
      position: number
    }[]
  } | null
  bid_line_item_quotes: { line_item_id: string; unit_cost: number }[]
  bid_comments: {
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
    <div className="min-h-dvh bg-background">
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

export default async function BidTokenPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params
  if (!ACCESS_TOKEN_RE.test(token)) notFound()

  const admin = createSupabaseAdminClient()
  if (!admin) return <Unavailable />

  const { data, error } = await admin
    .from("bid_recipients")
    .select(
      `id, status, flat_total, notes, viewed_at, submitted_at,
       companies:company_id(name),
       bid_packages:bid_package_id(
         id, project_id, number, title, scope, due_date, status, flat_fee,
         projects:project_id(name, project_type, org_id),
         bid_package_line_items(id, description, quantity, unit, position,
           cost_codes:cost_code_id(code, name)),
         bid_package_attachments(id, file_name, storage_path, caption, position)
       ),
       bid_line_item_quotes(line_item_id, unit_cost),
       bid_comments(id, author_name, author_profile_id, body, created_at)`
    )
    .eq("token", token)
    .maybeSingle()
  if (error) {
    console.warn("[bid page] lookup failed:", error.message)
    return <Unavailable />
  }
  if (!data) notFound()

  const rec = data as unknown as PageData
  const pkg = rec.bid_packages
  if (!pkg) notFound()
  // Service-role fetch bypasses the RLS rule hiding drafts — never expose a
  // package staff haven't released (possible if a send half-failed).
  if (pkg.status === "draft") notFound()

  // First-open tracking. Best-effort — never block the page on it.
  if (!rec.viewed_at) {
    const { error: viewErr } = await admin
      .from("bid_recipients")
      .update({ viewed_at: new Date().toISOString() })
      .eq("token", token)
      .is("viewed_at", null)
    if (viewErr) console.warn("[bid page] viewed_at stamp failed:", viewErr.message)
  }

  const brand = brandForProjectType(
    pkg.projects?.project_type,
    await getBrandConfig(admin, pkg.projects?.org_id)
  )
  const projectName = pkg.projects?.name ?? "our project"
  const packageClosed = pkg.status === "closed"

  const lineItems = [...pkg.bid_package_line_items].sort(
    (a, b) => a.position - b.position
  )
  const attachments = [...pkg.bid_package_attachments].sort(
    (a, b) => a.position - b.position
  )
  const comments = [...rec.bid_comments].sort((a, b) =>
    a.created_at.localeCompare(b.created_at)
  )

  // Signed URLs for attachments (private bucket) — 1 hour.
  const signed: Record<string, string> = {}
  if (attachments.length) {
    const { data: urls } = await admin.storage
      .from("project-files")
      .createSignedUrls(attachments.map((a) => a.storage_path), 3600)
    for (const u of urls ?? []) {
      if (u.path && u.signedUrl) signed[u.path] = u.signedUrl
    }
  }

  const banner = packageClosed
    ? { tone: "muted" as const, text: "Bidding on this package has closed." }
    : rec.status === "submitted"
      ? {
          tone: "info" as const,
          text: `Bid submitted ${formatDate(rec.submitted_at)}. We'll be in touch after review.`,
        }
      : rec.status === "declined"
        ? { tone: "muted" as const, text: "You declined this bid." }
        : rec.status === "awarded"
          ? {
              tone: "success" as const,
              text: "Congratulations — this bid was awarded to you. A purchase order will follow.",
            }
          : null

  const bannerClasses = {
    info: "border-blue-200 bg-blue-50 text-blue-900",
    success: "border-green-200 bg-green-50 text-green-900",
    muted: "border-border bg-background text-muted",
  }

  return (
    <Shell brandName={brand.name}>
      <Card>
        <CardHeader>
          <div className="flex flex-col gap-1">
            <p className="text-xs text-muted uppercase tracking-wide">
              Bid request — {projectName}
            </p>
            <CardTitle className="text-lg">{pkg.title}</CardTitle>
            <div className="flex flex-wrap items-center gap-2 pt-1">
              {pkg.due_date && !packageClosed && (
                <Badge tone="warning">Due {formatDate(pkg.due_date)}</Badge>
              )}
              {pkg.flat_fee ? (
                <Badge tone="neutral">Flat-fee bid</Badge>
              ) : (
                <Badge tone="neutral">Line-item bid</Badge>
              )}
            </div>
          </div>
        </CardHeader>
        {banner && (
          <div
            className={`mx-5 mt-4 rounded-md border px-4 py-3 text-sm ${bannerClasses[banner.tone]}`}
          >
            {banner.text}
          </div>
        )}
        <CardBody className="flex flex-col gap-4">
          {pkg.scope && (
            <div>
              <h2 className="text-xs font-medium text-muted uppercase tracking-wide mb-1">
                Scope of work
              </h2>
              <ScopeText text={pkg.scope} className="text-sm" />
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

      <BidResponseForm
        token={token}
        flatFee={pkg.flat_fee}
        lineItems={lineItems.map((li) => ({
          id: li.id,
          description: li.description,
          codeLabel: li.cost_codes
            ? `${li.cost_codes.code} ${li.cost_codes.name}`
            : null,
          quantity: Number(li.quantity),
          unit: li.unit,
        }))}
        initialQuotes={Object.fromEntries(
          rec.bid_line_item_quotes.map((q) => [
            q.line_item_id,
            String(q.unit_cost),
          ])
        )}
        initialFlatTotal={rec.flat_total}
        initialNotes={rec.notes ?? ""}
        status={rec.status}
        packageClosed={packageClosed}
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

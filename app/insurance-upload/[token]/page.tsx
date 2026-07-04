import { createSupabaseAdminClient } from "@/lib/supabase/admin"
import { UploadForm } from "./upload-form"

/**
 * Public, unauthenticated upload page for subcontractors. The URL token is
 * the company's insurance_upload_token, mailed to them by the expiration
 * reminder (or the staff "Send request" button). It grants exactly one
 * ability — POSTing a certificate to /api/insurance-upload — and reveals
 * nothing but the company name. Lives outside the (app) route group so no
 * sidebar/auth chrome applies; middleware never redirects (it only
 * refreshes sessions), so anonymous visitors land here fine.
 */

export const metadata = { title: "Upload insurance certificate — Hines Homes" }

export default async function InsuranceUploadPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params

  // Token lookup runs on the admin client — there's no session here, and
  // RLS (correctly) hides companies from anonymous users.
  let companyName: string | null = null
  const admin = createSupabaseAdminClient()
  if (admin && /^[0-9a-f-]{36}$/i.test(token)) {
    const { data } = await admin
      .from("companies")
      .select("name")
      .eq("insurance_upload_token", token)
      .maybeSingle()
    companyName = data?.name ?? null
  }

  return (
    <main className="min-h-dvh bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-lg rounded-xl border border-border bg-surface shadow-sm p-6 sm:p-8">
        <div className="flex items-center gap-2 mb-6">
          <div className="h-8 w-8 rounded-md bg-brand-500 text-white flex items-center justify-center font-bold text-sm">
            HH
          </div>
          <span className="font-semibold text-foreground">Hines Homes</span>
        </div>

        {companyName ? (
          <>
            <h1 className="text-xl font-semibold text-foreground">
              Upload insurance certificate
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Upload the current certificate of insurance for{" "}
              <span className="font-medium text-foreground">{companyName}</span>
              . A PDF from your insurance agent works best; a clear photo or
              scan is fine too. Certificates should show general liability and
              workers&rsquo; compensation coverage.
            </p>
            <div className="mt-6">
              <UploadForm token={token} />
            </div>
          </>
        ) : (
          <>
            <h1 className="text-xl font-semibold text-foreground">
              This link isn&rsquo;t valid
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              This upload link is no longer active. Please contact Hines Homes
              for a new link, or reply to the email that brought you here.
            </p>
          </>
        )}
      </div>
    </main>
  )
}

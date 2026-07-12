import type { Metadata } from "next"
import { createSupabaseAdminClient } from "@/lib/supabase/admin"
import { ACCESS_TOKEN_RE } from "@/lib/tokens"
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card"
import { CLIENT_DISCLAIMER_TEXT } from "@/lib/client-portal/disclaimer"
import { AcceptInviteForm } from "./accept-invite-form"

// Public tokenized page — outside the (app) group, so no auth shell. The token
// is the credential; the read uses the service-role client because
// client_invites has no anon RLS policy.
export const dynamic = "force-dynamic"

export const metadata: Metadata = {
  title: "Client portal invite — Hines Homes",
  robots: { index: false },
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh bg-background">
      <div className="max-w-md mx-auto p-4 flex flex-col gap-4">
        <header className="pt-2">
          <span className="text-lg font-semibold tracking-tight text-brand-700">
            Hines Homes
          </span>
        </header>
        {children}
      </div>
    </div>
  )
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <Shell>
      <Card>
        <CardBody className="text-center py-10 text-sm text-muted">
          {children}
        </CardBody>
      </Card>
    </Shell>
  )
}

export default async function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params

  const invalid = (
    <Notice>
      This invitation link is invalid or has been revoked. If you already set up
      your login,{" "}
      <a href="/login" className="text-brand-600 underline underline-offset-2">
        sign in here
      </a>
      .
    </Notice>
  )

  if (!ACCESS_TOKEN_RE.test(token)) return invalid

  const admin = createSupabaseAdminClient()
  if (!admin) {
    return (
      <Notice>
        Sign-up isn&apos;t available right now. Please contact Hines Homes.
      </Notice>
    )
  }

  const { data: invite } = await admin
    .from("client_invites")
    .select("email, name, accepted_at, projects:project_id(name)")
    .eq("token", token)
    .maybeSingle()

  if (!invite) return invalid

  const projectName =
    (invite as unknown as { projects: { name: string } | null }).projects
      ?.name ?? "your project"

  if (invite.accepted_at) {
    return (
      <Notice>
        This invitation has already been used.{" "}
        <a href="/login" className="text-brand-600 underline underline-offset-2">
          Sign in
        </a>{" "}
        with your email and password.
      </Notice>
    )
  }

  return (
    <Shell>
      <Card>
        <CardHeader>
          <p className="text-xs text-muted uppercase tracking-wide">
            Client portal — {projectName}
          </p>
          <CardTitle className="text-lg">Set up your login</CardTitle>
        </CardHeader>
        <CardBody className="flex flex-col gap-4">
          <p className="text-sm text-muted">
            You&apos;ve been invited to the online portal for{" "}
            <span className="font-medium text-foreground">{projectName}</span>.
            Create a password to review updates and approve change orders and
            selections.
          </p>
          <div className="text-sm">
            <span className="text-muted">Your email</span>
            <div className="font-medium break-all">{invite.email}</div>
          </div>
          <AcceptInviteForm token={token} disclaimer={CLIENT_DISCLAIMER_TEXT} />
        </CardBody>
      </Card>
    </Shell>
  )
}

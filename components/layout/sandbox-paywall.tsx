"use client"

import { useState } from "react"
import { Lock } from "lucide-react"

/**
 * Full-screen paywall for an expired sandbox/trial org (S1). Rendered by the
 * app layout over the shell — the app stays visible underneath (reinforcing
 * "keep your data"), but every interaction is captured here. The mutation
 * block that backs this at the data layer lands in S1b; the "Subscribe now"
 * CTA is wired to Stripe Checkout in S3 (today it's a placeholder). A sign-out
 * escape hatch keeps the owner from feeling trapped.
 */
export function SandboxPaywall() {
  const [notice, setNotice] = useState(false)

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-md rounded-xl border border-border bg-surface p-6 text-center shadow-2xl space-y-4">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-brand-500/10">
          <Lock className="h-6 w-6 text-brand-600" />
        </div>
        <h2 className="text-lg font-semibold tracking-tight">
          Your trial has concluded
        </h2>
        <p className="text-sm text-muted">
          Subscribe now to keep your custom dashboard, projects, and data
          intact.
        </p>
        <button
          type="button"
          onClick={() => setNotice(true)}
          className="w-full rounded-md bg-brand-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-brand-700 cursor-pointer"
        >
          Subscribe now
        </button>
        {notice && (
          <p className="text-xs text-muted">
            Subscription checkout is being set up — please reach out to your
            BuildFox contact to activate your subscription.
          </p>
        )}
        <form action="/auth/signout" method="post">
          <button
            type="submit"
            className="text-xs text-muted hover:text-foreground cursor-pointer"
          >
            Sign out
          </button>
        </form>
      </div>
    </div>
  )
}

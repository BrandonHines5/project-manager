"use client"

import { useEffect, useRef, useState } from "react"
import { Lock } from "lucide-react"
import { createSubscriptionCheckout } from "@/app/actions/billing"

/**
 * Full-screen paywall for an expired sandbox/trial org (S1). Rendered by the
 * app layout over the shell — the app stays visible underneath (reinforcing
 * "keep your data"), but the layout marks that shell `inert` so it's neither
 * clickable nor tabbable, and this dialog takes focus, making it a real modal
 * for keyboard + screen-reader users. The mutation block that backs this at the
 * data layer is S1b; "Subscribe now" starts Stripe Checkout via S3's
 * createSubscriptionCheckout (which returns a friendly message when billing
 * isn't configured yet). A sign-out escape hatch keeps the owner from feeling
 * trapped.
 */
export function SandboxPaywall() {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dialogRef = useRef<HTMLDivElement>(null)

  // Move focus into the dialog on mount; with the underlying shell inert, Tab
  // then cycles only within this dialog (an effective focus trap).
  useEffect(() => {
    dialogRef.current?.focus()
  }, [])

  async function onSubscribe() {
    setLoading(true)
    setError(null)
    try {
      const result = await createSubscriptionCheckout()
      if (result.ok) {
        // Redirect to Stripe Checkout; keep the button in its loading state
        // while the navigation happens.
        window.location.href = result.url
        return
      }
      setError(result.error)
    } catch {
      setError("Couldn't start checkout. Please try again.")
    }
    setLoading(false)
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="sandbox-paywall-title"
        tabIndex={-1}
        className="w-full max-w-md rounded-xl border border-border bg-surface p-6 text-center shadow-2xl outline-none space-y-4"
      >
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-brand-500/10">
          <Lock className="h-6 w-6 text-brand-600" />
        </div>
        <h2
          id="sandbox-paywall-title"
          className="text-lg font-semibold tracking-tight"
        >
          Your trial has concluded
        </h2>
        <p className="text-sm text-muted">
          Subscribe now to keep your custom dashboard, projects, and data
          intact.
        </p>
        <button
          type="button"
          onClick={onSubscribe}
          disabled={loading}
          className="w-full rounded-md bg-brand-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-brand-700 cursor-pointer disabled:cursor-not-allowed disabled:opacity-60"
        >
          {loading ? "Starting checkout…" : "Subscribe now"}
        </button>
        {error && (
          <p role="alert" className="text-xs text-danger">
            {error}
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

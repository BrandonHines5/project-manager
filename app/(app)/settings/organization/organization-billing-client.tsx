"use client"

import { useState, useTransition } from "react"
import { CreditCard } from "lucide-react"
import { Button } from "@/components/ui/button"
import { createBillingPortalSession } from "@/app/actions/billing"

/**
 * Billing section on Organization settings (Stage S / S3 follow-up). Renders
 * only for an org that already has a Stripe customer (i.e. it went through
 * checkout at least once), and opens the Stripe-hosted Customer Portal so an
 * owner/admin can update their card, view invoices, or cancel. Cancelling in
 * the portal flows back through the webhook, which re-freezes the org.
 */

const STATUS: Record<string, { label: string; tone: string }> = {
  active: { label: "Active", tone: "text-success" },
  trialing: { label: "Trialing", tone: "text-success" },
  past_due: { label: "Past due", tone: "text-warning" },
  incomplete: { label: "Incomplete", tone: "text-warning" },
  canceled: { label: "Canceled", tone: "text-danger" },
  unpaid: { label: "Unpaid", tone: "text-danger" },
  incomplete_expired: { label: "Inactive", tone: "text-muted" },
}

export function OrganizationBillingClient({
  subscriptionStatus,
}: {
  subscriptionStatus: string | null
}) {
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const status = subscriptionStatus
    ? (STATUS[subscriptionStatus] ?? {
        label: subscriptionStatus,
        tone: "text-muted",
      })
    : null

  function openPortal() {
    setError(null)
    start(async () => {
      const res = await createBillingPortalSession()
      if (res.ok) {
        // Keep the button in its loading state through the redirect.
        window.location.href = res.url
        return
      }
      setError(res.error)
    })
  }

  return (
    <section className="rounded-lg border border-border bg-surface p-5 space-y-4">
      <div className="flex items-start gap-2">
        <CreditCard className="h-4 w-4 mt-0.5 text-muted" />
        <div>
          <div className="text-sm font-medium">Billing</div>
          <div className="text-xs text-muted">
            Manage your subscription, update your payment method, or view
            invoices.
          </div>
        </div>
      </div>

      {status && (
        <div className="text-sm">
          Subscription:{" "}
          <span className={`font-medium ${status.tone}`}>{status.label}</span>
        </div>
      )}

      <div>
        <Button
          type="button"
          variant="secondary"
          onClick={openPortal}
          disabled={pending}
        >
          {pending ? "Opening…" : "Manage billing"}
        </Button>
      </div>

      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </section>
  )
}

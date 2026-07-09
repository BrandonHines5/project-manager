"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Button, buttonVariants } from "@/components/ui/button"
import {
  disconnectQboAction,
  runQboDiagnosticAction,
  type QboDiagnosticResult,
} from "@/app/actions/quickbooks"
import type { QboConnectionStatus } from "@/lib/quickbooks/storage"

// Human-readable messages for the ?error reasons the callback can redirect with.
const ERROR_LABELS: Record<string, string> = {
  access_denied: "You declined the QuickBooks connection.",
  missing_params: "QuickBooks didn't return the expected parameters. Please try again.",
  state_mismatch: "The connection attempt expired or didn't match. Please try again.",
  token_exchange_failed: "QuickBooks rejected the authorization. Check the app's keys and redirect URI, then retry.",
  save_failed: "Connected to QuickBooks, but couldn't store the connection. Try again.",
  not_configured: "QuickBooks isn't configured yet. Set the QBO_* environment variables, then retry.",
  authorize_url_failed: "Couldn't build the QuickBooks authorization link. Check the app configuration.",
}

export function QuickBooksSettingsClient({
  configured,
  status,
  justConnected,
  errorReason,
}: {
  configured: boolean
  status: QboConnectionStatus | null
  justConnected: boolean
  errorReason: string | null
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [docNumber, setDocNumber] = useState("1001")
  const [diagnostic, setDiagnostic] = useState<QboDiagnosticResult | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  function handleDisconnect() {
    if (!confirm("Disconnect QuickBooks? This revokes access and removes the stored tokens.")) return
    startTransition(async () => {
      const res = await disconnectQboAction()
      setMessage(res.ok ? "Disconnected from QuickBooks." : res.error ?? "Disconnect failed.")
      setDiagnostic(null)
      router.refresh()
    })
  }

  function handleDiagnostic() {
    setMessage(null)
    startTransition(async () => {
      const res = await runQboDiagnosticAction(docNumber)
      setDiagnostic(res)
    })
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">QuickBooks Online</h1>
      <p className="mt-1 text-sm text-muted">
        Push approved Purchase Orders into QuickBooks Online, where Adaptive imports
        them so vendor bills can be matched against the PO amount.
      </p>

      {justConnected && (
        <div className="mt-4 rounded-md border border-brand-500/30 bg-brand-500/10 px-4 py-3 text-sm">
          QuickBooks connected successfully.
        </div>
      )}
      {errorReason && (
        <div className="mt-4 rounded-md border border-danger/30 bg-danger/10 px-4 py-3 text-sm">
          {ERROR_LABELS[errorReason] ?? `Connection error: ${errorReason}`}
        </div>
      )}
      {message && (
        <div className="mt-4 rounded-md border border-border-strong bg-surface px-4 py-3 text-sm">
          {message}
        </div>
      )}

      {/* Connection state */}
      <section className="mt-6 rounded-lg border border-border bg-surface p-5">
        {!configured ? (
          <div className="text-sm">
            <div className="font-medium">Not configured</div>
            <p className="mt-1 text-muted">
              Set <code>QBO_CLIENT_ID</code>, <code>QBO_CLIENT_SECRET</code>, and{" "}
              <code>QBO_REDIRECT_URI</code> in the Vercel environment, then redeploy to
              enable the connection.
            </p>
          </div>
        ) : status ? (
          <div className="space-y-3 text-sm">
            <div className="flex items-center justify-between">
              <div>
                <div className="font-medium">
                  Connected{status.company_name ? ` — ${status.company_name}` : ""}
                </div>
                <div className="mt-1 text-muted">
                  Realm {status.realm_id} · {status.environment} · connected{" "}
                  {new Date(status.connected_at).toLocaleDateString()}
                </div>
              </div>
              <span className="rounded-full bg-brand-500/15 px-2.5 py-1 text-xs font-medium text-brand-700">
                Active
              </span>
            </div>
            <div className="flex flex-wrap gap-2 pt-1">
              <a
                href="/api/qbo/connect"
                className={buttonVariants({ variant: "outline", size: "sm" })}
              >
                Reconnect
              </a>
              <Button variant="danger" size="sm" onClick={handleDisconnect} disabled={pending}>
                Disconnect
              </Button>
            </div>
          </div>
        ) : (
          <div className="text-sm">
            <div className="font-medium">Not connected</div>
            <p className="mt-1 text-muted">
              Connect your QuickBooks Online company to start syncing purchase orders.
            </p>
            <a
              href="/api/qbo/connect"
              className={`${buttonVariants({ variant: "primary", size: "md" })} mt-3`}
            >
              Connect QuickBooks
            </a>
          </div>
        )}
      </section>

      {/* Diagnostic — read-only inspection of the connected file */}
      {configured && status && (
        <section className="mt-6 rounded-lg border border-border bg-surface p-5">
          <div className="font-medium text-sm">Connection diagnostic</div>
          <p className="mt-1 text-sm text-muted">
            Reads the company profile plus a sample of vendors, accounts, items, and one
            example purchase order — used to confirm the connection and see how this file
            structures a PO.
          </p>
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <label className="text-xs text-muted">
              Example PO #
              <input
                value={docNumber}
                onChange={(e) => setDocNumber(e.target.value)}
                className="mt-1 block h-8 w-28 rounded-md border border-border-strong bg-background px-2 text-sm text-foreground"
                placeholder="1001"
              />
            </label>
            <Button variant="secondary" size="sm" onClick={handleDiagnostic} disabled={pending}>
              {pending ? "Running…" : "Run diagnostic"}
            </Button>
          </div>

          {diagnostic && (
            <div className="mt-4">
              {diagnostic.ok ? (
                <pre className="max-h-96 overflow-auto rounded-md border border-border bg-background p-3 text-xs leading-5">
                  {JSON.stringify(diagnostic.snapshot, null, 2)}
                </pre>
              ) : (
                <div className="rounded-md border border-danger/30 bg-danger/10 px-4 py-3 text-sm">
                  {diagnostic.error}
                </div>
              )}
            </div>
          )}
        </section>
      )}

      <p className="mt-6 text-xs text-muted">
        Need help with this integration? Contact{" "}
        <a className="text-brand-600 underline" href="mailto:brandon@hineshomes.com">
          brandon@hineshomes.com
        </a>
        .
      </p>
    </div>
  )
}

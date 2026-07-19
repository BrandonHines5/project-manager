"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Plug } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { saveQuoIntegration } from "@/app/actions/org"

/**
 * Org integrations editor (B4). Today it manages Quo/OpenPhone; QBO and
 * Resend join here as they gain per-org config. The API key is write-only —
 * the page only ever tells us whether one is stored, never its value, so a
 * stored key can't leak back to the browser.
 */
export function OrganizationIntegrationsClient({
  orgId,
  quoConnected,
  quoSharedFrom,
  quoError,
  quoEnvFallback,
}: {
  orgId: string
  quoConnected: boolean
  quoSharedFrom: string
  quoError: boolean
  /** Legacy org runs off env QUO_API_KEY even with no stored row. */
  quoEnvFallback: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [apiKey, setApiKey] = useState("")
  const [sharedFrom, setSharedFrom] = useState(quoSharedFrom)

  const connected = quoConnected || quoEnvFallback

  function save(disconnect: boolean) {
    startTransition(async () => {
      const result = await saveQuoIntegration({
        orgId,
        apiKey: disconnect ? undefined : apiKey.trim() || undefined,
        sharedFromNumber: disconnect ? undefined : sharedFrom.trim(),
        disconnect,
      })
      if (result.ok) {
        toast.success(disconnect ? "Quo disconnected" : "Quo settings saved")
        setApiKey("")
        router.refresh()
      } else {
        toast.error(result.error ?? "Couldn't save the integration.")
      }
    })
  }

  return (
    <section className="rounded-lg border border-border bg-surface p-5 space-y-4">
      <div className="flex items-start gap-2">
        <Plug className="h-4 w-4 mt-0.5 text-muted" />
        <div>
          <div className="text-sm font-medium">Integrations</div>
          <div className="text-xs text-muted">
            Connect this organization&rsquo;s own accounts. Keys are stored
            encrypted and never shown again after saving.
          </div>
        </div>
      </div>

      <div className="rounded-md border border-border p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="text-sm font-medium">Quo / OpenPhone (texts &amp; calls)</div>
          <span
            className={
              quoError
                ? "text-xs text-danger"
                : connected
                  ? "text-xs text-brand-600"
                  : "text-xs text-muted"
            }
          >
            {quoError
              ? "Connection error"
              : quoEnvFallback && !quoConnected
                ? "Using shared key"
                : connected
                  ? "Connected"
                  : "Not connected"}
          </span>
        </div>
        {quoError && (
          <p className="text-xs text-danger">
            The stored key couldn&rsquo;t be read (the encryption key may be
            misconfigured). Re-enter the API key to reset it.
          </p>
        )}

        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted">API key</label>
          <Input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={
              quoConnected ? "•••••••• (leave blank to keep)" : "OpenPhone API key"
            }
            autoComplete="off"
            maxLength={300}
          />
          <p className="text-xs text-muted">
            From your OpenPhone workspace settings. Only needed to set or change
            the key.
          </p>
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted">
            Shared sending number
          </label>
          <Input
            value={sharedFrom}
            onChange={(e) => setSharedFrom(e.target.value)}
            placeholder="+15555550100 or PN…"
            maxLength={40}
          />
          <p className="text-xs text-muted">
            The fallback number for staff who don&rsquo;t have their own Quo
            number assigned. E.164 (+1…) or an OpenPhone number id.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => save(false)} disabled={pending}>
            {pending ? "Saving…" : "Save"}
          </Button>
          {quoConnected && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => save(true)}
              disabled={pending}
            >
              Disconnect
            </Button>
          )}
        </div>
      </div>
    </section>
  )
}

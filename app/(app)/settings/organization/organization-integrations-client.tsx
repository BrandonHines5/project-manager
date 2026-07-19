"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Plug } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { saveQuoIntegration, saveResendIntegration } from "@/app/actions/org"

/**
 * Org integrations editor (B4). Manages Quo/OpenPhone (texts & calls) and
 * Resend (email); QBO joins here as it gains a per-org editor. Every API key
 * is write-only — the page only ever tells us whether one is stored, never
 * its value, so a stored key can't leak back to the browser. Each card owns
 * its own transition/state so saving one never disables the other.
 */
export function OrganizationIntegrationsClient({
  orgId,
  quoConnected,
  quoSharedFrom,
  quoError,
  quoEnvFallback,
  resendConnected,
  resendFromEmail,
  resendFromName,
  resendError,
  resendEnvFallback,
}: {
  orgId: string
  quoConnected: boolean
  quoSharedFrom: string
  quoError: boolean
  /** Legacy org runs off env QUO_API_KEY even with no stored row. */
  quoEnvFallback: boolean
  resendConnected: boolean
  resendFromEmail: string
  resendFromName: string
  resendError: boolean
  /** Legacy org runs off env RESEND_* even with no stored row. */
  resendEnvFallback: boolean
}) {
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

      <QuoIntegrationCard
        orgId={orgId}
        connected={quoConnected}
        sharedFrom={quoSharedFrom}
        error={quoError}
        envFallback={quoEnvFallback}
      />
      <ResendIntegrationCard
        orgId={orgId}
        connected={resendConnected}
        fromEmail={resendFromEmail}
        fromName={resendFromName}
        error={resendError}
        envFallback={resendEnvFallback}
      />
    </section>
  )
}

/** Status badge shared by both cards. */
function StatusBadge({
  error,
  connected,
  envFallback,
}: {
  error: boolean
  connected: boolean
  envFallback: boolean
}) {
  const usingShared = envFallback && !connected
  const isOn = connected || envFallback
  return (
    <span
      className={
        error
          ? "text-xs text-danger"
          : isOn
            ? "text-xs text-brand-600"
            : "text-xs text-muted"
      }
    >
      {error
        ? "Connection error"
        : usingShared
          ? "Using shared key"
          : isOn
            ? "Connected"
            : "Not connected"}
    </span>
  )
}

/**
 * Quo/OpenPhone credentials card: a write-only API key + the shared fallback
 * sending number. `save(true)` disconnects (clears the stored key).
 */
function QuoIntegrationCard({
  orgId,
  connected,
  sharedFrom: initialSharedFrom,
  error,
  envFallback,
}: {
  orgId: string
  connected: boolean
  sharedFrom: string
  error: boolean
  envFallback: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [apiKey, setApiKey] = useState("")
  const [sharedFrom, setSharedFrom] = useState(initialSharedFrom)

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
        // router.refresh() re-renders with fresh props but doesn't reset local
        // state, so clear the disconnected field ourselves — otherwise a stale
        // number lingers in the input and could be re-submitted on a later save.
        if (disconnect) setSharedFrom("")
        router.refresh()
      } else {
        toast.error(result.error ?? "Couldn't save the integration.")
      }
    })
  }

  return (
    <div className="rounded-md border border-border p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium">Quo / OpenPhone (texts &amp; calls)</div>
        <StatusBadge error={error} connected={connected} envFallback={envFallback} />
      </div>
      {error && (
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
            connected ? "•••••••• (leave blank to keep)" : "OpenPhone API key"
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
        {connected && (
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
  )
}

/**
 * Resend email credentials card: a write-only API key + the verified From
 * address and optional display name the org sends under. `save(true)`
 * disconnects (clears the stored key).
 */
function ResendIntegrationCard({
  orgId,
  connected,
  fromEmail: initialFromEmail,
  fromName: initialFromName,
  error,
  envFallback,
}: {
  orgId: string
  connected: boolean
  fromEmail: string
  fromName: string
  error: boolean
  envFallback: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [apiKey, setApiKey] = useState("")
  const [fromEmail, setFromEmail] = useState(initialFromEmail)
  const [fromName, setFromName] = useState(initialFromName)

  function save(disconnect: boolean) {
    startTransition(async () => {
      const result = await saveResendIntegration({
        orgId,
        apiKey: disconnect ? undefined : apiKey.trim() || undefined,
        fromEmail: disconnect ? undefined : fromEmail.trim(),
        fromName: disconnect ? undefined : fromName.trim(),
        disconnect,
      })
      if (result.ok) {
        toast.success(disconnect ? "Email disconnected" : "Email settings saved")
        setApiKey("")
        // router.refresh() re-renders with fresh props but doesn't reset local
        // state, so clear the disconnected fields ourselves — otherwise a stale
        // From address/name lingers and could be re-submitted on a later save.
        if (disconnect) {
          setFromEmail("")
          setFromName("")
        }
        router.refresh()
      } else {
        toast.error(result.error ?? "Couldn't save the integration.")
      }
    })
  }

  return (
    <div className="rounded-md border border-border p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium">Resend (email)</div>
        <StatusBadge error={error} connected={connected} envFallback={envFallback} />
      </div>
      {error && (
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
            connected ? "•••••••• (leave blank to keep)" : "Resend API key"
          }
          autoComplete="off"
          maxLength={300}
        />
        <p className="text-xs text-muted">
          From your Resend dashboard (API Keys). Only needed to set or change
          the key.
        </p>
      </div>

      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted">From address</label>
        <Input
          type="email"
          value={fromEmail}
          onChange={(e) => setFromEmail(e.target.value)}
          placeholder="hello@yourbuilder.com"
          maxLength={200}
        />
        <p className="text-xs text-muted">
          A verified sending address on your Resend account. Outbound bid, PO,
          insurance, and client emails go out from here.
        </p>
      </div>

      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted">
          From name (optional)
        </label>
        <Input
          value={fromName}
          onChange={(e) => setFromName(e.target.value)}
          placeholder="Your Company Name"
          maxLength={120}
        />
        <p className="text-xs text-muted">
          The display name shown on the From line. Leave blank to send from the
          bare address.
        </p>
      </div>

      <div className="flex items-center gap-2">
        <Button size="sm" onClick={() => save(false)} disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </Button>
        {connected && (
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
  )
}

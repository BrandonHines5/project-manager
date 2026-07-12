"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Button, buttonVariants } from "@/components/ui/button"
import {
  disconnectQboAction,
  runQboDiagnosticAction,
  getQboLists,
  saveQboPushDefaults,
  type QboDiagnosticResult,
  type QboLists,
} from "@/app/actions/quickbooks"
import {
  saveInvoicePaymentRecipients,
  type PaymentRecipientConfig,
} from "@/app/actions/invoices"
import type { QboConnectionStatus } from "@/lib/quickbooks/storage"
import type { PushDefaults } from "@/lib/quickbooks/purchase-orders"

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
  pushDefaults,
  justConnected,
  errorReason,
  webhookUrl,
  webhookConfigured,
  paymentRecipients,
}: {
  configured: boolean
  status: QboConnectionStatus | null
  pushDefaults: PushDefaults | null
  justConnected: boolean
  errorReason: string | null
  webhookUrl: string
  webhookConfigured: boolean
  paymentRecipients: PaymentRecipientConfig | null
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [docNumber, setDocNumber] = useState("1001")
  const [diagnostic, setDiagnostic] = useState<QboDiagnosticResult | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  // Push-defaults state.
  const [lists, setLists] = useState<QboLists | null>(null)
  const [defaults, setDefaults] = useState<PushDefaults>(
    pushDefaults ?? { item_id: "", customer_id: null, class_id: null }
  )
  const [defaultsMsg, setDefaultsMsg] = useState<string | null>(null)
  // Note: this component is remounted (keyed on the connected realm in the
  // parent page) when the company changes, so the initial state above is always
  // re-derived from the new pushDefaults — no stale IDs from a prior company.

  function handleLoadLists() {
    setDefaultsMsg(null)
    startTransition(async () => {
      const res = await getQboLists()
      if (res.ok) setLists(res.lists)
      else setDefaultsMsg(res.error)
    })
  }

  function handleSaveDefaults() {
    startTransition(async () => {
      const res = await saveQboPushDefaults(defaults)
      setDefaultsMsg(res.ok ? "Push defaults saved." : res.error ?? "Save failed.")
      if (res.ok) router.refresh()
    })
  }

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
        Push approved Purchase Orders into QuickBooks Online (where Adaptive imports
        them so vendor bills can be matched against the PO amount), and mirror each
        job&rsquo;s QuickBooks invoices into the client portal.
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

      {/* Push defaults — the Item/Customer/Class used on pushed PO lines */}
      {configured && status && (
        <section className="mt-6 rounded-lg border border-border bg-surface p-5">
          <div className="font-medium text-sm">Push defaults</div>
          <p className="mt-1 text-sm text-muted">
            Approved POs are pushed as Item-based purchase orders. Pick the default
            Item, Customer (job), and Class applied to each line — mirroring how the
            connected file structures a PO. (The vendor comes from the PO&rsquo;s company,
            matched by name.)
          </p>
          {!lists ? (
            <div className="mt-3 space-y-2">
              <Button variant="secondary" size="sm" onClick={handleLoadLists} disabled={pending}>
                {pending ? "Loading…" : "Load QuickBooks options"}
              </Button>
              {defaults.item_id && (
                <p className="text-xs text-muted">
                  Current default Item id: <code>{defaults.item_id}</code>
                  {defaults.customer_id ? ` · Customer ${defaults.customer_id}` : ""}
                  {defaults.class_id ? ` · Class ${defaults.class_id}` : ""}
                </p>
              )}
            </div>
          ) : (
            <div className="mt-3 space-y-3">
              <SelectField
                label="Default Item (required)"
                value={defaults.item_id}
                options={lists.items}
                onChange={(v) => setDefaults((d) => ({ ...d, item_id: v }))}
              />
              <SelectField
                label="Default Customer / job"
                value={defaults.customer_id ?? ""}
                options={lists.customers}
                allowNone
                onChange={(v) => setDefaults((d) => ({ ...d, customer_id: v || null }))}
              />
              <SelectField
                label="Default Class"
                value={defaults.class_id ?? ""}
                options={lists.classes}
                allowNone
                onChange={(v) => setDefaults((d) => ({ ...d, class_id: v || null }))}
              />
              <Button
                variant="primary"
                size="sm"
                onClick={handleSaveDefaults}
                disabled={pending || !defaults.item_id}
              >
                {pending ? "Saving…" : "Save push defaults"}
              </Button>
            </div>
          )}
          {defaultsMsg && (
            <div className="mt-3 rounded-md border border-border-strong bg-background px-4 py-2 text-sm">
              {defaultsMsg}
            </div>
          )}
        </section>
      )}

      {/* Client invoices — webhook setup for the invoice sync */}
      {configured && status && (
        <section className="mt-6 rounded-lg border border-border bg-surface p-5">
          <div className="flex items-center justify-between gap-3">
            <div className="font-medium text-sm">Client invoices — webhook</div>
            <span
              className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                webhookConfigured
                  ? "bg-brand-500/15 text-brand-700"
                  : "bg-amber-100 text-amber-900"
              }`}
            >
              {webhookConfigured ? "Verifier token set" : "Verifier token missing"}
            </span>
          </div>
          <p className="mt-1 text-sm text-muted">
            Each job&rsquo;s Invoices tab mirrors the invoices of its linked QuickBooks
            customer. The webhook keeps that mirror current (and pings the team when a
            payment lands) — without it, invoices only update on a manual
            &ldquo;Sync now&rdquo;.
          </p>
          <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-sm text-muted">
            <li>
              In the Intuit developer portal, open this app&rsquo;s{" "}
              <span className="text-foreground">Webhooks</span> section and set the
              endpoint to{" "}
              <code className="rounded bg-background px-1.5 py-0.5 text-xs text-foreground">
                {webhookUrl}
              </code>
            </li>
            <li>
              Subscribe to the <span className="text-foreground">Invoice</span> and{" "}
              <span className="text-foreground">Payment</span> entities (all
              operations).
            </li>
            <li>
              Copy the portal&rsquo;s Verifier Token into the{" "}
              <code className="rounded bg-background px-1.5 py-0.5 text-xs text-foreground">
                QBO_WEBHOOK_VERIFIER_TOKEN
              </code>{" "}
              environment variable in Vercel, then redeploy.
            </li>
          </ol>
        </section>
      )}

      {/* Who gets the in-app "payment received" notification */}
      {configured && status && paymentRecipients && (
        <PaymentRecipientsSection config={paymentRecipients} />
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

function PaymentRecipientsSection({ config }: { config: PaymentRecipientConfig }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [selected, setSelected] = useState<Set<string>>(new Set(config.selected))
  const [message, setMessage] = useState<string | null>(null)

  function toggle(id: string) {
    setMessage(null)
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function handleSave() {
    startTransition(async () => {
      const res = await saveInvoicePaymentRecipients([...selected])
      setMessage(res.ok ? "Recipients saved." : res.error ?? "Save failed.")
      if (res.ok) router.refresh()
    })
  }

  return (
    <section className="mt-6 rounded-lg border border-border bg-surface p-5">
      <div className="font-medium text-sm">Payment notifications</div>
      <p className="mt-1 text-sm text-muted">
        Who gets the in-app notification when a client payment lands on an
        invoice. Uncheck everyone to turn the notification off.
      </p>
      <ul className="mt-3 space-y-1.5">
        {config.staff.map((p) => (
          <li key={p.id}>
            <label className="inline-flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={selected.has(p.id)}
                onChange={() => toggle(p.id)}
                className="h-4 w-4 rounded border-border-strong accent-brand-500"
              />
              {p.full_name}
            </label>
          </li>
        ))}
      </ul>
      <div className="mt-3 flex items-center gap-3">
        <Button variant="primary" size="sm" onClick={handleSave} disabled={pending}>
          {pending ? "Saving…" : "Save recipients"}
        </Button>
        {message && <span className="text-sm text-muted">{message}</span>}
      </div>
    </section>
  )
}

function SelectField({
  label,
  value,
  options,
  onChange,
  allowNone,
}: {
  label: string
  value: string
  options: { id: string; name: string }[]
  onChange: (value: string) => void
  allowNone?: boolean
}) {
  return (
    <label className="block text-xs text-muted">
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 block h-9 w-full max-w-md rounded-md border border-border-strong bg-background px-2 text-sm text-foreground"
      >
        <option value="">{allowNone ? "— None —" : "— Select —"}</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name} (#{o.id})
          </option>
        ))}
      </select>
    </label>
  )
}

"use client"

import { useId, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { ChevronRight, Plug, MessageSquare, Mail } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { saveQuoIntegration, saveResendIntegration } from "@/app/actions/org"
import { provisionTwilioNumber, releaseTwilioNumber } from "@/app/actions/twilio"

/**
 * Org integrations editor (B4). Legacy Hines: bring-your-own Quo/OpenPhone +
 * Resend cards. Builder orgs: keyless platform Twilio texting + platform
 * email, with bring-your-own OpenPhone available behind an "Advanced"
 * disclosure as the upgrade path (full phone app; wins the send dispatch when
 * connected). QBO joins here as it gains a per-org editor. Every API key is
 * write-only — the page only ever tells us whether one is stored, never its
 * value, so a stored key can't leak back to the browser. Each card owns its
 * own transition/state so saving one never disables the other.
 */
export function OrganizationIntegrationsClient({
  orgId,
  isLegacy,
  twilioConfigured,
  twilioNumber,
  platformEmailActive,
  platformEmailAddress,
  platformEmailIsCustom,
  platformEmailError,
  quoConnected,
  quoSharedFrom,
  quoWebhookConnected,
  quoWebhookUrl,
  quoError,
  quoEnvFallback,
  resendConnected,
  resendFromEmail,
  resendFromName,
  resendError,
  resendEnvFallback,
}: {
  orgId: string
  /**
   * The legacy (Hines) org keeps the bring-your-own OpenPhone/Quo card; every
   * other org gets platform-managed Twilio texting (no keys) instead.
   */
  isLegacy: boolean
  /** Whether the platform Twilio account is wired up (env creds present). */
  twilioConfigured: boolean
  /** The org's provisioned Twilio number, or null when it has none yet. */
  twilioNumber: string | null
  /** Whether outbound email is actually working for this org (effective identity). */
  platformEmailActive: boolean
  /** The EFFECTIVE sending address — a custom Resend override wins over the platform one. */
  platformEmailAddress: string | null
  /** True when the address is the org's own verified domain (a stored Resend override). */
  platformEmailIsCustom: boolean
  /** A stored Resend key that couldn't be decrypted — email is off (fail closed). */
  platformEmailError: boolean
  quoConnected: boolean
  quoSharedFrom: string
  /** Whether an OpenPhone webhook signing secret is stored (write-only). */
  quoWebhookConnected: boolean
  /** The inbound endpoint an OpenPhone workspace's webhook must point at. */
  quoWebhookUrl: string
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
            Connect this organization&rsquo;s accounts. Keys are stored
            encrypted and never shown again after saving.
          </div>
        </div>
      </div>

      {isLegacy ? (
        <QuoIntegrationCard
          orgId={orgId}
          isLegacy
          connected={quoConnected}
          sharedFrom={quoSharedFrom}
          webhookConnected={quoWebhookConnected}
          webhookUrl={quoWebhookUrl}
          error={quoError}
          envFallback={quoEnvFallback}
        />
      ) : (
        <>
          <TwilioSmsCard
            orgId={orgId}
            configured={twilioConfigured}
            number={twilioNumber}
            openPhoneActive={quoConnected}
          />
          {/* Bring-your-own OpenPhone — the upgrade path for teams that want a
              full phone app (calls + texts from an app on everyone's phone,
              mirrored here). Collapsed so the default keyless setup stays
              simple; auto-open when connected or erroring so its state is
              never hidden. */}
          <AdvancedDisclosure
            label="Using OpenPhone? Connect your own account"
            defaultOpen={quoConnected || quoError}
          >
            <QuoIntegrationCard
              orgId={orgId}
              isLegacy={false}
              connected={quoConnected}
              sharedFrom={quoSharedFrom}
              webhookConnected={quoWebhookConnected}
              webhookUrl={quoWebhookUrl}
              error={quoError}
              envFallback={quoEnvFallback}
            />
          </AdvancedDisclosure>
        </>
      )}
      {isLegacy ? (
        <ResendIntegrationCard
          orgId={orgId}
          connected={resendConnected}
          fromEmail={resendFromEmail}
          fromName={resendFromName}
          error={resendError}
          envFallback={resendEnvFallback}
        />
      ) : (
        <PlatformEmailCard
          active={platformEmailActive}
          address={platformEmailAddress}
          isCustom={platformEmailIsCustom}
          error={platformEmailError}
        />
      )}
    </section>
  )
}

/**
 * Platform-managed email for builder orgs — no API key, no DNS. The sending
 * address is derived from the org slug on the shared verified domain, so email
 * works out of the box; this card is informational. It shows the EFFECTIVE
 * sender: a stored custom Resend identity (an advanced override) is surfaced
 * distinctly from the platform-managed address so the card never claims a
 * different address than outbound mail actually uses.
 */
function PlatformEmailCard({
  active,
  address,
  isCustom,
  error,
}: {
  active: boolean
  address: string | null
  isCustom: boolean
  error: boolean
}) {
  return (
    <div className="rounded-md border border-border p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Mail className="h-4 w-4 text-muted" />
          Email
        </div>
        <span
          className={
            error
              ? "text-xs text-danger"
              : active
                ? "text-xs text-brand-600"
                : "text-xs text-muted"
          }
        >
          {error ? "Connection error" : active ? "Active" : "Not set up"}
        </span>
      </div>

      {error ? (
        <p className="text-xs text-danger">
          Your stored email key couldn&rsquo;t be read, so email is paused.
          Contact support to reset it.
        </p>
      ) : active && address && isCustom ? (
        <p className="text-sm">
          Your emails send from <span className="font-medium">{address}</span> —
          your own verified domain. Bid, PO, insurance, and client emails go out
          from here, and replies land in your Communications feed.
        </p>
      ) : active && address ? (
        <p className="text-sm">
          Emails are sent for you through BuildFox (from{" "}
          <span className="font-medium">{address}</span>) shown under your
          company&rsquo;s name. Bid, PO, insurance, and client emails go out this
          way, and replies land in your Communications feed — nothing to set up.
        </p>
      ) : (
        <p className="text-xs text-muted">
          Email isn&rsquo;t available yet. It&rsquo;ll appear here once it&rsquo;s
          switched on for your account.
        </p>
      )}
    </div>
  )
}

/** Collapsed-by-default wrapper for advanced/optional setup. */
function AdvancedDisclosure({
  label,
  defaultOpen,
  children,
}: {
  label: string
  defaultOpen: boolean
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  const contentId = useId()
  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={contentId}
        className="flex items-center gap-1 text-xs text-muted hover:text-foreground transition-colors"
      >
        <ChevronRight
          className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-90" : ""}`}
        />
        {label}
      </button>
      <div id={contentId} hidden={!open}>
        {children}
      </div>
    </div>
  )
}

/**
 * Platform-managed text messaging (Twilio) for builder orgs — no API key. The
 * org provisions a dedicated number in one click; releasing it stops billing.
 * Texting ONLY — the number takes no voice calls (calls stay on personal
 * phones, or on OpenPhone once the org upgrades). When the org has its own
 * OpenPhone account connected, that wins the send dispatch and this number
 * sits on standby.
 */
function TwilioSmsCard({
  orgId,
  configured,
  number,
  openPhoneActive,
}: {
  orgId: string
  configured: boolean
  number: string | null
  /** The org's own OpenPhone account is connected and handles texting. */
  openPhoneActive: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [areaCode, setAreaCode] = useState("")

  function provision() {
    startTransition(async () => {
      const result = await provisionTwilioNumber({ orgId, areaCode: areaCode.trim() })
      if (result.ok) {
        toast.success(`Your texting number is ${result.phoneNumber}`)
        router.refresh()
      } else {
        toast.error(result.error ?? "Couldn't set up text messaging.")
      }
    })
  }

  function release() {
    startTransition(async () => {
      const result = await releaseTwilioNumber({ orgId })
      if (result.ok) {
        toast.success("Texting number released")
        router.refresh()
      } else {
        toast.error(result.error ?? "Couldn't release the number.")
      }
    })
  }

  return (
    <div className="rounded-md border border-border p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-medium">
          <MessageSquare className="h-4 w-4 text-muted" />
          Text messaging
        </div>
        <span
          className={
            number && !openPhoneActive
              ? "text-xs text-brand-600"
              : "text-xs text-muted"
          }
        >
          {number ? (openPhoneActive ? "On standby" : "Active") : "Not set up"}
        </span>
      </div>

      {!configured ? (
        <p className="text-xs text-muted">
          Text messaging isn&rsquo;t available yet. It&rsquo;ll appear here once
          it&rsquo;s switched on for your account.
        </p>
      ) : number ? (
        <div className="space-y-3">
          {openPhoneActive ? (
            <p className="text-sm">
              Your OpenPhone account is connected, so texting goes through
              OpenPhone. Your BuildFox number{" "}
              <span className="font-medium">{number}</span> is on standby — you
              can release it if you no longer need it, or keep it as a
              fallback.
            </p>
          ) : (
            <p className="text-sm">
              Your texting number is{" "}
              <span className="font-medium">{number}</span>. Texts you send to
              subs and clients go out from here, and replies land in your
              Communications feed. This number is for text messages only — it
              doesn&rsquo;t take voice calls, so phone calls stay on your
              regular phone.
            </p>
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={release}
            disabled={pending}
          >
            {pending ? "Releasing…" : "Release number"}
          </Button>
        </div>
      ) : openPhoneActive ? (
        <p className="text-xs text-muted">
          Your OpenPhone account is connected and handles texting, so
          there&rsquo;s nothing to set up here. If you ever disconnect
          OpenPhone, come back to get a built-in texting number.
        </p>
      ) : (
        <div className="space-y-3">
          <p className="text-xs text-muted">
            Get a dedicated phone number for texting subs and clients. No setup
            or accounts to create — we handle it. Texting only (the number
            doesn&rsquo;t take voice calls). Optionally pick an area code.
          </p>
          <div className="flex items-center gap-2">
            <Input
              value={areaCode}
              onChange={(e) => setAreaCode(e.target.value.replace(/\D/g, "").slice(0, 3))}
              placeholder="Area code (optional)"
              inputMode="numeric"
              maxLength={3}
              className="max-w-[180px]"
            />
            <Button size="sm" onClick={provision} disabled={pending}>
              {pending ? "Setting up…" : "Get a texting number"}
            </Button>
          </div>
        </div>
      )}
    </div>
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
 *
 * Non-legacy (builder) orgs see this inside the "Advanced" disclosure as the
 * bring-your-own upgrade path from the keyless Twilio number, with an extra
 * write-only webhook signing secret so THEIR workspace's replies and Quo-app
 * texts/calls mirror into the feed (legacy Hines' webhook secret stays env).
 */
function QuoIntegrationCard({
  orgId,
  isLegacy,
  connected,
  sharedFrom: initialSharedFrom,
  webhookConnected,
  webhookUrl,
  error,
  envFallback,
}: {
  orgId: string
  isLegacy: boolean
  connected: boolean
  sharedFrom: string
  webhookConnected: boolean
  webhookUrl: string
  error: boolean
  envFallback: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [apiKey, setApiKey] = useState("")
  const [sharedFrom, setSharedFrom] = useState(initialSharedFrom)
  const [webhookSecret, setWebhookSecret] = useState("")

  function save(disconnect: boolean) {
    startTransition(async () => {
      const result = await saveQuoIntegration({
        orgId,
        apiKey: disconnect ? undefined : apiKey.trim() || undefined,
        sharedFromNumber: disconnect ? undefined : sharedFrom.trim(),
        webhookSecret: disconnect ? undefined : webhookSecret.trim() || undefined,
        disconnect,
      })
      if (result.ok) {
        toast.success(
          disconnect ? "OpenPhone disconnected" : "OpenPhone settings saved"
        )
        setApiKey("")
        setWebhookSecret("")
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
        <div className="text-sm font-medium">
          {isLegacy
            ? "Quo / OpenPhone (texts & calls)"
            : "OpenPhone (bring your own account)"}
        </div>
        <StatusBadge error={error} connected={connected} envFallback={envFallback} />
      </div>
      {!isLegacy && (
        <p className="text-xs text-muted">
          For teams that want a full phone app — everyone texting and calling
          from business numbers in the OpenPhone app, with everything mirrored
          into your Communications feed. Connecting takes over texting from
          your BuildFox number, and you can port that number into OpenPhone so
          contacts stay the same. Assign each person their own OpenPhone number
          on the Team page.
        </p>
      )}
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

      {!isLegacy && (
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted">
            Webhook signing secret
          </label>
          <Input
            type="password"
            value={webhookSecret}
            onChange={(e) => setWebhookSecret(e.target.value)}
            placeholder={
              webhookConnected
                ? "•••••••• (leave blank to keep)"
                : "OpenPhone webhook signing secret"
            }
            autoComplete="off"
            maxLength={300}
          />
          <p className="text-xs text-muted break-all">
            In OpenPhone, add a webhook for message and call events pointing at{" "}
            <span className="font-medium">{webhookUrl}</span>, then paste its
            signing secret here. That&rsquo;s how replies and texts or calls
            made in the OpenPhone app show up in your Communications feed.
          </p>
        </div>
      )}

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

"use client"

import { useMemo, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Mail, MessageCircle, SquarePen } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, Input, Select, Textarea } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import {
  clientComposeMessage,
  composeMessage,
} from "@/app/actions/communications"

/**
 * A pickable recipient for the compose dialog. Known contacts carry the
 * server-resolvable `recipient` handle — the address shown here is display
 * only; composeMessage re-resolves it server-side. Custom entry (a number or
 * address not on file) is always offered as the last option.
 */
export type ComposeContact = {
  /** Unique key across the list, e.g. `company:<id>` / `client:1`. */
  id: string
  name: string
  /** Small qualifier after the name, e.g. "client", "Plumbing". */
  detail?: string | null
  email: string | null
  phone: string | null
  recipient:
    | { kind: "company"; company_id: string }
    | { kind: "project_client"; project_id: string; slot: 1 | 2 }
}

const CUSTOM = "custom"
const SMS_LIMIT = 1600

/**
 * "New message" — start a text or email straight from a Communications tab.
 * Texts go out via the staffer's own Quo number (shared-number fallback);
 * emails via the normal sendEmail transports. Either way the send lands in
 * the communications log, so the feed the user is looking at picks it up on
 * the refresh this triggers.
 */
export function ComposeMessageButton({
  contacts,
  projectId,
}: {
  contacts: ComposeContact[]
  /** Job to file the message under — set on the project tab, null globally. */
  projectId?: string | null
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [channel, setChannel] = useState<"sms" | "email">("sms")
  const [contactId, setContactId] = useState("")
  const [customAddress, setCustomAddress] = useState("")
  const [customName, setCustomName] = useState("")
  const [subject, setSubject] = useState("")
  const [body, setBody] = useState("")
  const [pending, startTransition] = useTransition()

  // Only contacts reachable on the active channel are offered.
  const available = useMemo(
    () => contacts.filter((c) => (channel === "sms" ? c.phone : c.email)),
    [contacts, channel]
  )
  const selected =
    contactId && contactId !== CUSTOM
      ? available.find((c) => c.id === contactId)
      : undefined

  const canSend =
    Boolean(body.trim()) &&
    (channel === "sms" || Boolean(subject.trim())) &&
    (contactId === CUSTOM ? Boolean(customAddress.trim()) : Boolean(selected))

  function reset() {
    setContactId("")
    setCustomAddress("")
    setCustomName("")
    setSubject("")
    setBody("")
  }

  // Reset on EVERY close path (Cancel, backdrop, Escape, post-send) so a
  // canceled draft can't be re-sent later to a different recipient unnoticed.
  function handleOpenChange(next: boolean) {
    setOpen(next)
    if (!next) reset()
  }

  function switchChannel(next: "sms" | "email") {
    setChannel(next)
    // Keep the selection when the contact is reachable both ways; otherwise
    // clear it so a phone-only pick can't linger under the Email tab.
    if (contactId && contactId !== CUSTOM) {
      const still = contacts.find(
        (c) => c.id === contactId && (next === "sms" ? c.phone : c.email)
      )
      if (!still) setContactId("")
    }
  }

  function send() {
    if (!canSend || pending) return
    const recipient =
      contactId === CUSTOM
        ? {
            kind: "custom" as const,
            name: customName.trim() || null,
            address: customAddress.trim(),
          }
        : selected!.recipient
    startTransition(async () => {
      const result = await composeMessage({
        channel,
        project_id: projectId ?? null,
        recipient,
        subject: channel === "email" ? subject.trim() : null,
        body: body.trim(),
      })
      if (!result.ok) {
        toast.error(result.error ?? "Failed to send.")
        return
      }
      toast.success(channel === "sms" ? "Text sent" : "Email sent")
      handleOpenChange(false)
      router.refresh()
    })
  }

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <SquarePen className="h-3.5 w-3.5 mr-1.5" />
        New message
      </Button>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent size="md">
          <DialogHeader>
            <div>
              <DialogTitle>New message</DialogTitle>
              <DialogDescription>
                Send a text or email — it&apos;s logged here automatically.
              </DialogDescription>
            </div>
          </DialogHeader>
          <DialogBody className="space-y-4">
            <div className="flex gap-1">
              {(
                [
                  { key: "sms", label: "Text", icon: MessageCircle },
                  { key: "email", label: "Email", icon: Mail },
                ] as const
              ).map((c) => (
                <button
                  key={c.key}
                  type="button"
                  onClick={() => switchChannel(c.key)}
                  className={cn(
                    "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border transition-colors cursor-pointer",
                    channel === c.key
                      ? "bg-brand-500 text-white border-brand-500"
                      : "bg-surface text-muted border-border hover:text-foreground"
                  )}
                >
                  <c.icon className="h-3.5 w-3.5" />
                  {c.label}
                </button>
              ))}
            </div>

            <Field
              label="To"
              htmlFor="compose-to"
              hint={
                selected
                  ? channel === "sms"
                    ? `Texts ${selected.phone} from your Quo number`
                    : `Emails ${selected.email}`
                  : undefined
              }
            >
              <Select
                id="compose-to"
                value={contactId}
                onChange={(e) => setContactId(e.target.value)}
              >
                <option value="">Choose a contact…</option>
                {available.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.detail ? ` (${c.detail})` : ""} —{" "}
                    {channel === "sms" ? c.phone : c.email}
                  </option>
                ))}
                <option value={CUSTOM}>
                  {channel === "sms"
                    ? "Enter a phone number…"
                    : "Enter an email address…"}
                </option>
              </Select>
            </Field>

            {contactId === CUSTOM && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Field
                  label={channel === "sms" ? "Phone number" : "Email address"}
                  htmlFor="compose-address"
                >
                  <Input
                    id="compose-address"
                    type={channel === "sms" ? "tel" : "email"}
                    value={customAddress}
                    onChange={(e) => setCustomAddress(e.target.value)}
                    placeholder={
                      channel === "sms" ? "(555) 555-5555" : "name@example.com"
                    }
                  />
                </Field>
                <Field
                  label="Name (optional)"
                  htmlFor="compose-name"
                  hint="Shown as the contact in the feed"
                >
                  <Input
                    id="compose-name"
                    value={customName}
                    onChange={(e) => setCustomName(e.target.value)}
                    placeholder="Who is this?"
                  />
                </Field>
              </div>
            )}

            {channel === "email" && (
              <Field label="Subject" htmlFor="compose-subject">
                <Input
                  id="compose-subject"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  maxLength={200}
                  placeholder="Subject"
                />
              </Field>
            )}

            <Field label="Message" htmlFor="compose-body">
              <Textarea
                id="compose-body"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={5}
                maxLength={channel === "sms" ? SMS_LIMIT : 10_000}
                placeholder={
                  channel === "sms" ? "Type your text…" : "Type your email…"
                }
              />
            </Field>
          </DialogBody>
          <DialogFooter>
            {channel === "sms" && (
              <span className="mr-auto text-xs text-muted tabular-nums">
                {body.length}/{SMS_LIMIT}
              </span>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => handleOpenChange(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button size="sm" onClick={send} disabled={pending || !canSend}>
              {pending
                ? "Sending…"
                : channel === "sms"
                  ? "Send text"
                  : "Send email"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

/**
 * The client-portal counterpart: "New message" with no recipient picker — it
 * always goes to the team. The send lands in this project's feed (visible to
 * the client under their own RLS read) and staff get notified in-app + email.
 */
export function ClientComposeButton({ projectId }: { projectId: string }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [subject, setSubject] = useState("")
  const [body, setBody] = useState("")
  const [pending, startTransition] = useTransition()

  function handleOpenChange(next: boolean) {
    setOpen(next)
    if (!next) {
      setSubject("")
      setBody("")
    }
  }

  function send() {
    if (!body.trim() || pending) return
    startTransition(async () => {
      const result = await clientComposeMessage({
        project_id: projectId,
        subject: subject.trim() || null,
        body: body.trim(),
      })
      if (!result.ok) {
        toast.error(result.error ?? "Failed to send.")
        return
      }
      toast.success("Message sent")
      handleOpenChange(false)
      router.refresh()
    })
  }

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <SquarePen className="h-3.5 w-3.5 mr-1.5" />
        New message
      </Button>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent size="md">
          <DialogHeader>
            <div>
              <DialogTitle>Message the team</DialogTitle>
              <DialogDescription>
                Goes straight to our team — we&apos;ll get back to you here.
              </DialogDescription>
            </div>
          </DialogHeader>
          <DialogBody className="space-y-4">
            <Field label="Subject (optional)" htmlFor="client-compose-subject">
              <Input
                id="client-compose-subject"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                maxLength={200}
                placeholder="What's this about?"
              />
            </Field>
            <Field label="Message" htmlFor="client-compose-body">
              <Textarea
                id="client-compose-body"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={5}
                maxLength={10_000}
                placeholder="Type your message…"
                autoFocus
              />
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => handleOpenChange(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button size="sm" onClick={send} disabled={pending || !body.trim()}>
              {pending ? "Sending…" : "Send"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

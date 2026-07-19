"use client"

import { useState, useTransition } from "react"
import { toast } from "sonner"
import { Building2, Check, Copy } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  provisionOrganization,
  type ProvisionOrgResult,
} from "@/app/actions/provisioning"

/** Derive a create_organization-valid slug from free text (best-effort). */
function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
}

type Success = Extract<ProvisionOrgResult, { ok: true }>

export function ProvisionOrgClient() {
  const [pending, startTransition] = useTransition()
  const [orgName, setOrgName] = useState("")
  const [slug, setSlug] = useState("")
  const [slugTouched, setSlugTouched] = useState(false)
  const [ownerName, setOwnerName] = useState("")
  const [ownerEmail, setOwnerEmail] = useState("")
  const [result, setResult] = useState<Success | null>(null)
  const [copied, setCopied] = useState(false)

  function onNameChange(v: string) {
    setOrgName(v)
    // Keep the slug tracking the name until the operator edits it directly.
    if (!slugTouched) setSlug(slugify(v))
  }

  function submit() {
    startTransition(async () => {
      const res = await provisionOrganization({
        orgName: orgName.trim(),
        slug: slug.trim(),
        ownerName: ownerName.trim(),
        ownerEmail: ownerEmail.trim(),
      })
      if (res.ok) {
        setResult(res)
        toast.success("Organization created")
      } else {
        toast.error(res.error)
      }
    })
  }

  function provisionAnother() {
    setResult(null)
    setOrgName("")
    setSlug("")
    setSlugTouched(false)
    setOwnerName("")
    setOwnerEmail("")
    setCopied(false)
  }

  async function copyPassword() {
    if (!result) return
    try {
      await navigator.clipboard.writeText(result.tempPassword)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error("Couldn't copy — select and copy the password manually.")
    }
  }

  const canSubmit =
    orgName.trim() && slug.trim() && ownerName.trim() && ownerEmail.trim()

  return (
    <div className="max-w-2xl mx-auto px-4 md:px-6 py-6 space-y-4">
      <div className="flex items-start gap-2">
        <Building2 className="h-5 w-5 mt-0.5 text-muted" />
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            Provision organization
          </h1>
          <p className="mt-1 text-sm text-muted">
            Stand up a new builder organization and its owner. Cost codes and
            roles are copied from Hines Homes as a starting point; branding and
            integrations are configured afterward in the new org&rsquo;s
            settings.
          </p>
        </div>
      </div>

      {result ? (
        <div className="rounded-lg border border-border bg-surface p-5 space-y-4">
          <div className="flex items-center gap-2 text-sm font-medium text-brand-700">
            <Check className="h-4 w-4" />
            Organization created
          </div>
          <p className="text-sm text-muted">
            Share these one-time sign-in credentials with the owner. The
            password is shown once — it can&rsquo;t be retrieved later (reset it
            from the Team page if needed).
          </p>
          <div className="rounded-md border border-border divide-y divide-border text-sm">
            <div className="flex items-center justify-between gap-3 px-3 py-2">
              <span className="text-muted">Owner email</span>
              <span className="font-medium break-all">{result.ownerEmail}</span>
            </div>
            <div className="flex items-center justify-between gap-3 px-3 py-2">
              <span className="text-muted">Temporary password</span>
              <span className="flex items-center gap-2">
                <code className="font-mono text-sm">{result.tempPassword}</code>
                <button
                  type="button"
                  onClick={copyPassword}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-background hover:text-foreground cursor-pointer"
                  aria-label="Copy password"
                >
                  {copied ? (
                    <Check className="h-4 w-4 text-brand-600" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                </button>
              </span>
            </div>
          </div>
          <p className="text-xs text-muted">
            The owner lands in their own organization on first sign-in. To view
            it yourself you&rsquo;d need to be added as a member — this stays a
            separate tenant with no access to Hines data.
          </p>
          <Button size="sm" onClick={provisionAnother}>
            Provision another
          </Button>
        </div>
      ) : (
        <div className="rounded-lg border border-border bg-surface p-5 space-y-4">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted">
              Organization name
            </label>
            <Input
              value={orgName}
              onChange={(e) => onNameChange(e.target.value)}
              placeholder="Acme Builders"
              maxLength={120}
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted">URL slug</label>
            <Input
              value={slug}
              onChange={(e) => {
                setSlugTouched(true)
                setSlug(e.target.value)
              }}
              placeholder="acme-builders"
              maxLength={63}
            />
            <p className="text-xs text-muted">
              Lowercase letters, digits, and dashes (2–63 chars). Used for
              per-org routing (e.g. the insurance intake plus-tag).
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted">
                Owner name
              </label>
              <Input
                value={ownerName}
                onChange={(e) => setOwnerName(e.target.value)}
                placeholder="Jordan Rivera"
                maxLength={200}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted">
                Owner email
              </label>
              <Input
                type="email"
                value={ownerEmail}
                onChange={(e) => setOwnerEmail(e.target.value)}
                placeholder="owner@acmebuilders.com"
                autoComplete="off"
                maxLength={200}
              />
            </div>
          </div>

          <div className="flex items-center gap-2 pt-1">
            <Button size="sm" onClick={submit} disabled={pending || !canSubmit}>
              {pending ? "Creating…" : "Create organization"}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

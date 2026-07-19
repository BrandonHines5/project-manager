"use client"

import { useRef, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Upload, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { createSupabaseBrowserClient } from "@/lib/supabase/client"
import { uploadToStorage } from "@/lib/storage/upload"
import { saveOrgSettings, type BrandInput } from "@/app/actions/org"

// Neutral app fallbacks parseBrandConfig fills when a slot is unset — shown
// as the preview after "Remove" so the editor matches what will render.
const FALLBACK_LOGO = "/brand/buildfox-mark.svg"
const FALLBACK_ICON = "/icon-512.png"

// No SVG on purpose: the bucket is public and a raw SVG opened as a top-level
// document executes embedded script (self-XSS). Raster covers logo needs.
const LOGO_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
}
const ICON_TYPES: Record<string, string> = { "image/png": "png" }
const MAX_IMAGE_BYTES = 4 * 1024 * 1024

type BrandDraft = {
  name: string
  logoUrl: string
  logoPath: string | null
  clearLogo: boolean
  iconUrl: string
  iconPath: string | null
  clearIcon: boolean
}

type BrandInitial = { name: string; logo: string; icon: string }

function draftFrom(initial: BrandInitial): BrandDraft {
  return {
    name: initial.name,
    logoUrl: initial.logo,
    logoPath: null,
    clearLogo: false,
    iconUrl: initial.icon,
    iconPath: null,
    clearIcon: false,
  }
}

function brandInput(draft: BrandDraft): BrandInput {
  return {
    name: draft.name.trim(),
    logoPath: draft.logoPath,
    iconPath: draft.iconPath,
    clearLogo: draft.clearLogo,
    clearIcon: draft.clearIcon,
  }
}

export function OrganizationSettingsClient({
  orgId,
  initialName,
  initialDefault,
  initialCommercial,
}: {
  orgId: string
  initialName: string
  initialDefault: BrandInitial
  initialCommercial: BrandInitial | null
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  // Count of in-flight image uploads across every slot — Save is disabled
  // while any are running so a save can't capture a stale draft (the picked
  // image would silently miss the save while the toast still says success).
  const [uploadingCount, setUploadingCount] = useState(0)
  const trackUploading = (busy: boolean) =>
    setUploadingCount((n) => Math.max(0, n + (busy ? 1 : -1)))
  const busy = pending || uploadingCount > 0
  const [name, setName] = useState(initialName)
  const [def, setDef] = useState<BrandDraft>(() => draftFrom(initialDefault))
  const [commercialEnabled, setCommercialEnabled] = useState(
    initialCommercial != null
  )
  const [commercial, setCommercial] = useState<BrandDraft>(() =>
    draftFrom(
      initialCommercial ?? { name: "", logo: FALLBACK_LOGO, icon: FALLBACK_ICON }
    )
  )

  function handleSave() {
    if (uploadingCount > 0) {
      toast.error("Wait for the image upload to finish before saving.")
      return
    }
    if (!name.trim()) {
      toast.error("Organization name is required.")
      return
    }
    if (!def.name.trim()) {
      toast.error("The default brand needs a name.")
      return
    }
    if (commercialEnabled && !commercial.name.trim()) {
      toast.error("The commercial sub-brand needs a name (or turn it off).")
      return
    }
    startTransition(async () => {
      const result = await saveOrgSettings({
        orgId,
        name: name.trim(),
        defaultBrand: brandInput(def),
        commercialBrand: commercialEnabled ? brandInput(commercial) : null,
      })
      if (result.ok) {
        toast.success("Organization settings saved")
        router.refresh()
      } else {
        toast.error(result.error ?? "Couldn't save organization settings.")
      }
    })
  }

  return (
    <div className="max-w-2xl mx-auto px-4 md:px-6 py-6 space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Organization</h1>
        <p className="mt-1 text-sm text-muted">
          The organization name is internal; the brands below are what clients
          and subs see — in the app header, client pages, printable pricing,
          and the emails and public pages sent for bids and purchase orders.
        </p>
      </div>

      <section className="rounded-lg border border-border bg-surface p-5 space-y-3">
        <div className="text-sm font-medium">Organization name</div>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Organization name"
          maxLength={120}
        />
      </section>

      <BrandEditor
        title="Default brand"
        subtitle="Used everywhere unless a commercial sub-brand applies."
        orgId={orgId}
        slotPrefix="default"
        draft={def}
        onChange={setDef}
        disabled={pending}
        onUploadingChange={trackUploading}
      />

      <section className="rounded-lg border border-border bg-surface p-5 space-y-3">
        <label className="flex items-start gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={commercialEnabled}
            onChange={(e) => setCommercialEnabled(e.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-border-strong accent-brand-500"
          />
          <span>
            <span className="block text-sm font-medium">
              Commercial sub-brand
            </span>
            <span className="block text-xs text-muted">
              Commercial projects present under this brand instead of the
              default one. Turning it off makes every project use the default
              brand.
            </span>
          </span>
        </label>
        {commercialEnabled && (
          <BrandFields
            orgId={orgId}
            slotPrefix="commercial"
            draft={commercial}
            onChange={setCommercial}
            disabled={pending}
            onUploadingChange={trackUploading}
          />
        )}
      </section>

      <div>
        <Button onClick={handleSave} disabled={busy}>
          {pending
            ? "Saving…"
            : uploadingCount > 0
              ? "Uploading image…"
              : "Save settings"}
        </Button>
      </div>
    </div>
  )
}

function BrandEditor(props: {
  title: string
  subtitle: string
  orgId: string
  slotPrefix: string
  draft: BrandDraft
  onChange: (d: BrandDraft) => void
  disabled: boolean
  onUploadingChange: (busy: boolean) => void
}) {
  return (
    <section className="rounded-lg border border-border bg-surface p-5 space-y-3">
      <div>
        <div className="text-sm font-medium">{props.title}</div>
        <div className="text-xs text-muted">{props.subtitle}</div>
      </div>
      <BrandFields {...props} />
    </section>
  )
}

function BrandFields({
  orgId,
  slotPrefix,
  draft,
  onChange,
  disabled,
  onUploadingChange,
}: {
  orgId: string
  slotPrefix: string
  draft: BrandDraft
  onChange: (d: BrandDraft) => void
  disabled: boolean
  onUploadingChange: (busy: boolean) => void
}) {
  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted">Brand name</label>
        <Input
          value={draft.name}
          onChange={(e) => onChange({ ...draft, name: e.target.value })}
          placeholder="Brand name"
          maxLength={80}
        />
      </div>
      <ImageSlot
        label="Logo"
        hint="Shown in the app header, client pages, and PDF headers. PNG, JPG, SVG, or WebP."
        orgId={orgId}
        slot={`${slotPrefix}-logo`}
        accept={LOGO_TYPES}
        previewUrl={draft.logoUrl}
        fallbackUrl={FALLBACK_LOGO}
        isCustom={draft.logoPath != null || (!draft.clearLogo && draft.logoUrl !== FALLBACK_LOGO)}
        disabled={disabled}
        onUploadingChange={onUploadingChange}
        onUploaded={(path, url) =>
          onChange({ ...draft, logoPath: path, logoUrl: url, clearLogo: false })
        }
        onClear={() =>
          onChange({
            ...draft,
            logoPath: null,
            logoUrl: FALLBACK_LOGO,
            clearLogo: true,
          })
        }
      />
      <ImageSlot
        label="Square icon"
        hint="Favicon + link preview on the public bid/PO pages. Square PNG (512px works best)."
        orgId={orgId}
        slot={`${slotPrefix}-icon`}
        accept={ICON_TYPES}
        previewUrl={draft.iconUrl}
        fallbackUrl={FALLBACK_ICON}
        isCustom={draft.iconPath != null || (!draft.clearIcon && draft.iconUrl !== FALLBACK_ICON)}
        disabled={disabled}
        onUploadingChange={onUploadingChange}
        onUploaded={(path, url) =>
          onChange({ ...draft, iconPath: path, iconUrl: url, clearIcon: false })
        }
        onClear={() =>
          onChange({
            ...draft,
            iconPath: null,
            iconUrl: FALLBACK_ICON,
            clearIcon: true,
          })
        }
      />
    </div>
  )
}

function ImageSlot({
  label,
  hint,
  orgId,
  slot,
  accept,
  previewUrl,
  fallbackUrl,
  isCustom,
  disabled,
  onUploadingChange,
  onUploaded,
  onClear,
}: {
  label: string
  hint: string
  orgId: string
  slot: string
  accept: Record<string, string>
  previewUrl: string
  fallbackUrl: string
  isCustom: boolean
  disabled: boolean
  /** Mirrors the local uploading state up so Save can wait for every slot. */
  onUploadingChange: (busy: boolean) => void
  onUploaded: (path: string, url: string) => void
  onClear: () => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)

  async function pick(file: File) {
    const ext = accept[file.type]
    if (!ext) {
      toast.error(
        `That file type isn't supported here — use ${Object.values(accept)
          .map((e) => e.toUpperCase())
          .join(", ")}.`
      )
      return
    }
    if (file.size > MAX_IMAGE_BYTES) {
      toast.error("Keep brand images under 4 MB.")
      return
    }
    setUploading(true)
    onUploadingChange(true)
    try {
      const supabase = createSupabaseBrowserClient()
      // Random path per upload — old assets stay behind (cheap, and anything
      // already sent in an email keeps rendering).
      const path = `${orgId}/${slot}-${crypto.randomUUID()}.${ext}`
      const result = await uploadToStorage(supabase, {
        bucket: "brand-assets",
        path,
        body: file,
        contentType: file.type,
        // Public brand assets are immutable at their random path.
        cacheControl: "31536000",
      })
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      const url = supabase.storage.from("brand-assets").getPublicUrl(path)
        .data.publicUrl
      onUploaded(path, url)
    } catch (e) {
      // uploadToStorage returns errors rather than throwing, so this is the
      // truly unexpected path — still surface it instead of a silent reset.
      toast.error(e instanceof Error ? e.message : "Upload failed — try again.")
    } finally {
      setUploading(false)
      onUploadingChange(false)
    }
  }

  return (
    <div className="space-y-1.5">
      <label className="text-xs font-medium text-muted">{label}</label>
      <div className="flex items-center gap-3">
        <span className="inline-flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-md bg-white ring-1 ring-black/10">
          {/* Brand assets come from /public or the public bucket — plain img. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={previewUrl}
            alt={label}
            className="h-11 w-11 object-contain"
          />
        </span>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled || uploading}
            onClick={() => inputRef.current?.click()}
          >
            <Upload className="h-3.5 w-3.5 mr-1.5" />
            {uploading ? "Uploading…" : "Upload"}
          </Button>
          {isCustom && previewUrl !== fallbackUrl && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={disabled || uploading}
              onClick={onClear}
            >
              <X className="h-3.5 w-3.5 mr-1" />
              Remove
            </Button>
          )}
        </div>
        <input
          ref={inputRef}
          type="file"
          accept={Object.keys(accept).join(",")}
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            e.target.value = ""
            if (file) void pick(file)
          }}
        />
      </div>
      <p className="text-xs text-muted">{hint}</p>
    </div>
  )
}

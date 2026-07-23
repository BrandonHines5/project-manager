"use client"

import { useRef, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { toastActionError, actionErrorMessage } from "@/lib/action-error"
import { Droplets, FileDown, Send, Loader2, CheckCircle2, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { EmptyState } from "@/components/ui/empty"
import { Field, Input, Select, Textarea } from "@/components/ui/input"
import { SearchableSelect } from "@/components/ui/searchable-select"
import {
  saveUtilityDrafts,
  generateUtilityPdfs,
  sendUtilityForms,
  updateUtilityStatus,
  deleteUtilityRequest,
  getUtilityPrefill,
  type SaveEntryT,
} from "@/app/actions/utilities"

const METER_SIZES = ["5/8", "3/4", "1", "1 1/2", "2", "3", "4"] as const
type MeterSize = (typeof METER_SIZES)[number]
const METER_PROMPT_SQFT = 4000

// The two fillable providers. `key` is the short UI handle.
const PROVIDERS = [
  { key: "caw", value: "central_arkansas_water", label: "Central Arkansas Water", hint: "water service" },
  { key: "lumber", value: "lumber_one", label: "Lumber One", hint: "new job set-up" },
] as const
type ProviderKey = (typeof PROVIDERS)[number]["key"]

const PROVIDER_BADGE: Record<string, string> = {
  central_arkansas_water: "CAW",
  lumber_one: "Lumber One",
}

// One pickable job. Sourced from the CRM (all active jobs — In Work or
// Upcoming), each linked to a local project when one shares its
// project_number; falls back to the local project list when the CRM
// connection isn't configured. `key` is the stable dropdown value.
export type UtilityJob = {
  key: string
  project_id: string | null
  crm_project_id: string | null
  label: string
  address: string | null
  crm_status: "In Work" | "Upcoming" | null
}

export type UtilitiesData = {
  jobs: UtilityJob[]
  jobsSource: "crm" | "local"
  requests: UtilityRequestRow[]
  builder: {
    companyName: string
    email: string
    phone: string
    mailingAddress: string
    preparerName: string
    tinSet: boolean
  }
  cawConfigured: boolean
  lumberConfigured: boolean
  paymentUrl: string
  cawSubmissionEmail: string
  lumberSubmissionEmail: string
}

export type UtilityRequestRow = {
  id: string
  project_id: string | null
  crm_project_id: string | null
  project_label: string
  provider: string
  status: "draft" | "submitted" | "awaiting_payment" | "paid" | "complete"
  form_data: Record<string, unknown>
  payment_url: string | null
  submitted_at: string | null
  paid_at: string | null
  created_at: string
  files: { path: string; filename: string; url: string }[]
}

// Shared property answers + the CAW-only service details. The shared fields
// (date, address, city, zip, subdivision, lot) feed BOTH providers' forms so
// they're only typed once.
type FormState = {
  date: string
  serviceAddress: string
  city: string
  zip: string
  subdivision: string
  block: string
  lot: string
  existingWaterService: boolean
  existingBuildings: string
  newBuildings: string
  multiStory: boolean
  floors: string
  multiFamily: boolean
  unitsPerMeter: string
  septicTank: boolean
  publicSewer: boolean
  squareFootage: string
  meterSize: MeterSize
  remarks: string
  includeStandpipe: boolean
}

// Lumber One-only answers. Salesperson Initials/Number, Acct #, and Estimated
// Sales stay blank on the form for Brad, so they aren't asked here.
type LumberState = {
  jobName: string
  county: string
  inCityLimits: boolean
  propertyOwner: string
  deliveryDirections: string
}

function todayLocal(): string {
  const d = new Date()
  const mm = String(d.getMonth() + 1).padStart(2, "0")
  const dd = String(d.getDate()).padStart(2, "0")
  return `${mm}/${dd}/${d.getFullYear()}`
}

function emptyForm(): FormState {
  return {
    date: todayLocal(),
    serviceAddress: "",
    city: "",
    zip: "",
    subdivision: "",
    block: "",
    lot: "",
    existingWaterService: false,
    existingBuildings: "0",
    newBuildings: "1",
    multiStory: false,
    floors: "",
    multiFamily: false,
    unitsPerMeter: "",
    septicTank: false,
    publicSewer: true,
    squareFootage: "",
    meterSize: "5/8",
    remarks: "",
    includeStandpipe: true,
  }
}

function emptyLumber(): LumberState {
  return {
    jobName: "",
    county: "",
    inCityLimits: false, // default No per Brandon
    propertyOwner: "",
    deliveryDirections: "",
  }
}

const str = (d: Record<string, unknown>, k: string, fb: string) =>
  typeof d[k] === "string" ? (d[k] as string) : fb
const bool = (d: Record<string, unknown>, k: string, fb: boolean) =>
  typeof d[k] === "boolean" ? (d[k] as boolean) : fb

/** Rehydrate a saved CAW draft's form_data into form state (defaults fill gaps). */
function formFromData(d: Record<string, unknown>): FormState {
  const base = emptyForm()
  const meter = String(d.meterSize ?? base.meterSize)
  return {
    date: str(d, "date", base.date),
    serviceAddress: str(d, "serviceAddress", ""),
    city: str(d, "city", ""),
    zip: str(d, "zip", ""),
    subdivision: str(d, "subdivision", ""),
    block: str(d, "block", ""),
    lot: str(d, "lot", ""),
    existingWaterService: bool(d, "existingWaterService", false),
    existingBuildings: str(d, "existingBuildings", "0"),
    newBuildings: str(d, "newBuildings", "1"),
    multiStory: bool(d, "multiStory", false),
    floors: str(d, "floors", ""),
    multiFamily: bool(d, "multiFamily", false),
    unitsPerMeter: str(d, "unitsPerMeter", ""),
    septicTank: bool(d, "septicTank", false),
    publicSewer: bool(d, "publicSewer", true),
    squareFootage: str(d, "squareFootage", ""),
    meterSize: (METER_SIZES as readonly string[]).includes(meter)
      ? (meter as MeterSize)
      : base.meterSize,
    remarks: str(d, "remarks", ""),
    includeStandpipe: bool(d, "includeStandpipe", true),
  }
}

/** Rehydrate a Lumber One draft's provider-specific answers. */
function lumberFromData(d: Record<string, unknown>): LumberState {
  return {
    jobName: str(d, "jobName", ""),
    county: str(d, "county", ""),
    inCityLimits: bool(d, "inCityLimits", false),
    propertyOwner: str(d, "propertyOwner", ""),
    deliveryDirections: str(d, "deliveryDirections", ""),
  }
}

/** Merge a Lumber One draft's SHARED fields into the property form state. */
function sharedFromLumberData(d: Record<string, unknown>, base: FormState): FormState {
  return {
    ...base,
    date: str(d, "date", base.date),
    serviceAddress: str(d, "streetAddress", base.serviceAddress),
    city: str(d, "city", base.city),
    zip: str(d, "zip", base.zip),
    subdivision: str(d, "subdivision", base.subdivision),
    lot: str(d, "lot", base.lot),
  }
}

/** Best-effort split of a single-line project address into street/city/zip. */
function parseAddress(addr: string | null): { street: string; city: string; zip: string } {
  if (!addr) return { street: "", city: "", zip: "" }
  const parts = addr.split(",").map((s) => s.trim()).filter(Boolean)
  const street = parts[0] ?? ""
  let city = parts.length >= 2 ? parts[1] : ""
  // Anchor to the end of the string (the "AR 72223" tail) so a 5-digit house
  // number (e.g. "12345 Highway 10") isn't mistaken for the ZIP.
  const zipMatch = addr.match(/\b(\d{5})(?:-\d{4})?\s*$/)
  const zip = zipMatch ? zipMatch[1] : ""
  // If "city" is actually "City AR 72223", trim the state+zip tail.
  city = city.replace(/\s+[A-Z]{2}\s+\d{5}(?:-\d{4})?$/, "").trim()
  return { street, city, zip }
}

const STATUS_TONE: Record<UtilityRequestRow["status"], "neutral" | "info" | "warning" | "success" | "muted"> = {
  draft: "neutral",
  submitted: "info",
  awaiting_payment: "warning",
  paid: "success",
  complete: "muted",
}

function statusLabel(req: UtilityRequestRow): string {
  if (req.status === "submitted") {
    return req.provider === "lumber_one" ? "Sent to Lumber One" : "Submitted to CAW"
  }
  const labels: Record<UtilityRequestRow["status"], string> = {
    draft: "Draft",
    submitted: "Submitted",
    awaiting_payment: "Awaiting payment",
    paid: "Paid",
    complete: "Complete",
  }
  return labels[req.status]
}

/** Do two requests reference the same job (on either link)? */
function sameJob(a: UtilityRequestRow, b: UtilityRequestRow): boolean {
  return Boolean(
    (a.crm_project_id && a.crm_project_id === b.crm_project_id) ||
      (a.project_id && a.project_id === b.project_id)
  )
}

type GeneratedFile = { provider: ProviderKey; filename: string; url: string }

export function UtilitiesClient({ data }: { data: UtilitiesData }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [jobKey, setJobKey] = useState("")
  // Which providers' forms are being filled — CAW, Lumber One, or both.
  const [selected, setSelected] = useState<Record<ProviderKey, boolean>>({
    caw: true,
    lumber: true,
  })
  const [currentIds, setCurrentIds] = useState<Record<ProviderKey, string | null>>({
    caw: null,
    lumber: null,
  })
  const [form, setForm] = useState<FormState>(emptyForm())
  const [lumber, setLumber] = useState<LumberState>(emptyLumber())
  const [generated, setGenerated] = useState<GeneratedFile[]>([])
  // Tracks the most recent job selection so a slow CRM prefill for an earlier
  // job can't land on top of a newer one (see onSelectJob).
  const latestPrefillJobKey = useRef<string>("")

  const selectedJob = data.jobs.find((j) => j.key === jobKey)
  const selectedProviders = PROVIDERS.filter((p) => selected[p.key])

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => {
    setForm((f) => ({ ...f, [k]: v }))
    // Editing answers invalidates any generated PDFs — clear the previews so a
    // stale set can't be sent; the user must regenerate before sending.
    setGenerated([])
  }
  const setL = <K extends keyof LumberState>(k: K, v: LumberState[K]) => {
    setLumber((f) => ({ ...f, [k]: v }))
    setGenerated([])
  }

  const sqft = parseInt(form.squareFootage || "0", 10) || 0
  const meterWarning = sqft > METER_PROMPT_SQFT && form.meterSize === "5/8"

  function toggleProvider(key: ProviderKey) {
    setSelected((s) => ({ ...s, [key]: !s[key] }))
    setGenerated([])
  }

  function onSelectJob(key: string) {
    latestPrefillJobKey.current = key
    setJobKey(key)
    setCurrentIds({ caw: null, lumber: null })
    setGenerated([])
    const job = data.jobs.find((x) => x.key === key)
    // Start from CLEAN defaults — carrying the previous job's answers over
    // (subdivision, county, gate code, owner…) would silently put the wrong
    // job's data on the forms whenever the new job's CRM row can't prefill a
    // field. Instant fallback from the job's address line; CRM pull refines it.
    const { street, city, zip } = parseAddress(job?.address ?? null)
    setForm({ ...emptyForm(), serviceAddress: street, city, zip })
    setLumber({ ...emptyLumber(), jobName: street })
    if (!key || !job) return
    // Pull the richer property details (city, ZIP, subdivision, lot/block,
    // sq ft, floors, county, property owner…) from the CRM and merge them in.
    startTransition(async () => {
      try {
        const pre = await getUtilityPrefill({
          projectId: job.project_id,
          crmId: job.crm_project_id,
        })
        // A newer job was picked while this request was in flight — drop it.
        if (latestPrefillJobKey.current !== key) return
        setForm((f) => ({
          ...f,
          serviceAddress: pre.serviceAddress ?? f.serviceAddress,
          city: pre.city ?? f.city,
          zip: pre.zip ?? f.zip,
          subdivision: pre.subdivision ?? f.subdivision,
          block: pre.block ?? f.block,
          lot: pre.lot ?? f.lot,
          squareFootage: pre.squareFootage ?? f.squareFootage,
          multiStory: pre.multiStory ?? f.multiStory,
          floors: pre.floors ?? f.floors,
        }))
        setLumber((l) => ({
          ...l,
          jobName: pre.jobName ?? pre.serviceAddress ?? l.jobName,
          county: pre.county ?? l.county,
          propertyOwner: pre.propertyOwner ?? l.propertyOwner,
          deliveryDirections: pre.deliveryDirections ?? l.deliveryDirections,
        }))
        if (pre.source === "crm") toast.success("Pre-filled from CRM.")
      } catch {
        // Best-effort — the local address parse is already applied.
      }
    })
  }

  function resetForm() {
    setJobKey("")
    setCurrentIds({ caw: null, lumber: null })
    setGenerated([])
    setForm(emptyForm())
    setLumber(emptyLumber())
  }

  function handleContinue(req: UtilityRequestRow) {
    // Match on either link — a pre-CRM draft carries only project_id, while
    // the dropdown entry for the same job is keyed by its CRM id.
    const job = data.jobs.find(
      (j) =>
        (req.crm_project_id && j.crm_project_id === req.crm_project_id) ||
        (req.project_id && j.project_id === req.project_id)
    )
    // Load the sibling draft too, when the same job has one for the other
    // provider — both were likely filled together.
    const sibling = data.requests.find(
      (r) =>
        r.id !== req.id &&
        r.status === "draft" &&
        r.provider !== req.provider &&
        sameJob(r, req)
    )
    const cawReq = [req, sibling].find((r) => r?.provider === "central_arkansas_water")
    const lumberReq = [req, sibling].find((r) => r?.provider === "lumber_one")

    setJobKey(job?.key ?? "")
    setSelected({ caw: Boolean(cawReq), lumber: Boolean(lumberReq) })
    setCurrentIds({ caw: cawReq?.id ?? null, lumber: lumberReq?.id ?? null })
    // Shared fields prefer the CAW draft (it holds the superset); a
    // lumber-only draft maps its street address back onto the property form.
    let f = cawReq ? formFromData(cawReq.form_data) : emptyForm()
    if (!cawReq && lumberReq) f = sharedFromLumberData(lumberReq.form_data, f)
    setForm(f)
    setLumber(lumberReq ? lumberFromData(lumberReq.form_data) : emptyLumber())
    setGenerated(
      [
        ...(cawReq?.files.map((x) => ({ provider: "caw" as const, filename: x.filename, url: x.url })) ?? []),
        ...(lumberReq?.files.map((x) => ({ provider: "lumber" as const, filename: x.filename, url: x.url })) ?? []),
      ]
    )
    if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" })
  }

  /** The Lumber One form payload: shared property fields + its own extras. */
  function lumberFormPayload() {
    return {
      date: form.date,
      jobName: lumber.jobName,
      streetAddress: form.serviceAddress,
      city: form.city,
      zip: form.zip,
      county: lumber.county,
      subdivision: form.subdivision,
      lot: form.lot,
      inCityLimits: lumber.inCityLimits,
      propertyOwner: lumber.propertyOwner,
      deliveryDirections: lumber.deliveryDirections,
    }
  }

  /**
   * Save the selected providers' drafts. Commits whatever ids came back even
   * when some entries failed (so a retry UPDATES the committed row instead of
   * inserting a duplicate), then throws the per-provider errors, if any.
   */
  async function ensureSaved(job: UtilityJob): Promise<Record<ProviderKey, string | null>> {
    const entries: SaveEntryT[] = []
    if (selected.caw) {
      entries.push({ provider: "central_arkansas_water", id: currentIds.caw, form })
    }
    if (selected.lumber) {
      entries.push({ provider: "lumber_one", id: currentIds.lumber, form: lumberFormPayload() })
    }
    const { ids, errors } = await saveUtilityDrafts({
      project_id: job.project_id,
      crm_project_id: job.crm_project_id,
      entries,
    })
    const next: Record<ProviderKey, string | null> = {
      caw: ids.central_arkansas_water ?? currentIds.caw,
      lumber: ids.lumber_one ?? currentIds.lumber,
    }
    setCurrentIds(next)
    const failed = Object.entries(errors)
    if (failed.length > 0) {
      throw new Error(
        failed
          .map(([prov, msg]) => `${PROVIDER_BADGE[prov] ?? prov}: ${msg}`)
          .join(" — ")
      )
    }
    return next
  }

  function requireSelection(): boolean {
    if (!selectedJob) {
      toast.error("Pick a job first.")
      return false
    }
    if (selectedProviders.length === 0) {
      toast.error("Pick at least one form to fill out.")
      return false
    }
    return true
  }

  function handleSave() {
    if (!requireSelection()) return
    startTransition(async () => {
      try {
        await ensureSaved(selectedJob!)
        toast.success("Draft saved.")
        router.refresh()
      } catch (e) {
        toastActionError(e, "Save failed.")
      }
    })
  }

  function handleGenerate() {
    if (!requireSelection()) return
    if (!form.serviceAddress.trim()) return toast.error("Service address is required.")
    startTransition(async () => {
      try {
        const ids = await ensureSaved(selectedJob!)
        const out: GeneratedFile[] = []
        for (const p of selectedProviders) {
          const id = ids[p.key]
          if (!id) continue
          const { files } = await generateUtilityPdfs({ requestId: id })
          out.push(...files.map((f) => ({ provider: p.key, filename: f.filename, url: f.url })))
        }
        setGenerated(out)
        toast.success(`Generated ${out.length} form${out.length === 1 ? "" : "s"}.`)
        router.refresh()
      } catch (e) {
        toastActionError(e, "Generation failed.")
      }
    })
  }

  function handleSend() {
    const targets = selectedProviders.filter(
      (p) => currentIds[p.key] && generated.some((g) => g.provider === p.key)
    )
    if (targets.length === 0 || targets.length !== selectedProviders.length) {
      return toast.error("Generate the forms first.")
    }
    startTransition(async () => {
      const failed: ProviderKey[] = []
      for (const p of targets) {
        try {
          const res = await sendUtilityForms({ requestId: currentIds[p.key]! })
          if (res.sent) {
            toast.success(
              `Emailed to ${p.key === "caw" ? data.cawSubmissionEmail : data.lumberSubmissionEmail}.`
            )
          } else {
            failed.push(p.key)
            toast.error(`${p.label}: ${res.reason ?? "Could not send."}`)
          }
        } catch (e) {
          failed.push(p.key)
          toast.error(`${p.label}: ${actionErrorMessage(e, "Send failed.")}`)
        }
      }
      if (failed.length === 0) {
        resetForm()
      } else {
        // Clear ONLY the providers that actually went out (they're submitted
        // now). Failed ones stay active for a retry, and a loaded-but-
        // deselected provider's draft must keep its id — nulling it would
        // insert a duplicate draft on the next save.
        const sentOk = targets.map((p) => p.key).filter((k) => !failed.includes(k))
        setSelected((s) => ({
          caw: sentOk.includes("caw") ? false : s.caw,
          lumber: sentOk.includes("lumber") ? false : s.lumber,
        }))
        setCurrentIds((ids) => ({
          caw: sentOk.includes("caw") ? null : ids.caw,
          lumber: sentOk.includes("lumber") ? null : ids.lumber,
        }))
        setGenerated((g) => g.filter((f) => !sentOk.includes(f.provider)))
      }
      router.refresh()
    })
  }

  function handleDelete(req: UtilityRequestRow) {
    if (
      !confirm(
        `Delete the ${statusLabel(req).toLowerCase()} request for ${req.project_label}? Its generated forms are removed too. This can't be undone.`
      )
    )
      return
    startTransition(async () => {
      try {
        const res = await deleteUtilityRequest({ requestId: req.id })
        if (!res.ok) {
          toast.error(res.error ?? "Delete failed.")
          return
        }
        // If that request was loaded in the form above, detach just ITS slot —
        // wiping the whole form would discard unsaved edits to the sibling
        // provider's draft that's still loaded.
        const slot: ProviderKey | null =
          currentIds.caw === req.id ? "caw" : currentIds.lumber === req.id ? "lumber" : null
        if (slot) {
          setCurrentIds((ids) => ({ ...ids, [slot]: null }))
          setGenerated((g) => g.filter((f) => f.provider !== slot))
        }
        toast.success("Request deleted.")
        router.refresh()
      } catch (e) {
        toastActionError(e, "Delete failed.")
      }
    })
  }

  function advance(id: string, status: "awaiting_payment" | "paid" | "complete") {
    startTransition(async () => {
      try {
        const res = await updateUtilityStatus({ requestId: id, status })
        if (!res.ok) {
          toast.error(res.error ?? "Update failed.")
          return
        }
        router.refresh()
      } catch (e) {
        toastActionError(e, "Update failed.")
      }
    })
  }

  const configuredFor: Record<ProviderKey, boolean> = {
    caw: data.cawConfigured,
    lumber: data.lumberConfigured,
  }
  const canSend =
    selectedProviders.length > 0 &&
    selectedProviders.every(
      (p) =>
        currentIds[p.key] &&
        generated.some((g) => g.provider === p.key) &&
        configuredFor[p.key]
    )

  const sendLabel =
    selectedProviders.length === 2
      ? "Send to CAW & Lumber One"
      : selected.lumber
        ? "Send to Lumber One"
        : "Send to CAW"

  return (
    <div className="px-4 md:px-6 py-5 max-w-5xl">
      <div className="mb-5">
        <h1 className="text-lg font-semibold flex items-center gap-2">
          <Droplets className="h-5 w-5 text-brand-600" />
          Initiate Utilities
        </h1>
        <p className="text-sm text-muted mt-0.5">
          Pick a job to pre-fill the provider forms, answer a few questions, then
          generate and email them — water service to Central Arkansas Water, the
          job set-up form to Lumber One, or both at once.
        </p>
      </div>

      {!data.cawConfigured && (
        <div className="mb-5 rounded-md border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning">
          CAW builder details aren&apos;t filled in yet (company name, phone, email,
          mailing address). You can generate and preview forms, but sending to CAW is
          disabled until those are set in the app config.
        </div>
      )}

      <Card className="mb-6">
        <CardHeader className="flex items-center justify-between">
          <CardTitle>New request</CardTitle>
          <div className="flex items-center gap-1.5">
            {selectedProviders.map((p) => (
              <Badge key={p.key} tone="info">
                {PROVIDER_BADGE[p.value]}
              </Badge>
            ))}
          </div>
        </CardHeader>
        <CardBody className="space-y-5">
          <div className="grid sm:grid-cols-2 gap-4">
            <Field
              label="Forms to fill out"
              hint="Both forms share the property details below — fill once, send to each."
            >
              <div className="flex flex-col gap-2 pt-1.5">
                {PROVIDERS.map((p) => (
                  <label key={p.key} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={selected[p.key]}
                      onChange={() => toggleProvider(p.key)}
                      className="h-4 w-4 rounded border-border-strong"
                    />
                    {p.label}
                    <span className="text-xs text-muted">({p.hint})</span>
                  </label>
                ))}
              </div>
            </Field>
            <Field
              label="Job"
              hint={
                data.jobsSource === "crm"
                  ? "All active jobs (In Work / Upcoming) from the CRM. Picking one pre-fills the property details."
                  : "CRM not connected — showing this app's projects. Picking one pre-fills the property details."
              }
            >
              <SearchableSelect
                value={jobKey}
                onChange={onSelectJob}
                options={
                  data.jobsSource === "crm"
                    ? // Grouped by CRM status — flattened in group order with
                      // the group label carried as each option's hint.
                      (["In Work", "Upcoming", null] as const).flatMap((status) =>
                        data.jobs
                          .filter((j) => j.crm_status === status)
                          .map((j) => ({
                            value: j.key,
                            label: j.label,
                            hint: status ?? "Other",
                          }))
                      )
                    : data.jobs.map((j) => ({ value: j.key, label: j.label }))
                }
                placeholder="Choose a job…"
                ariaLabel="Job"
              />
            </Field>
          </div>

          {selectedJob && (
            <>
              <Section title="Property">
                <div className="grid sm:grid-cols-2 gap-4">
                  <Field label="Date">
                    <Input value={form.date} onChange={(e) => set("date", e.target.value)} />
                  </Field>
                  <Field label="Service address">
                    <Input
                      value={form.serviceAddress}
                      onChange={(e) => set("serviceAddress", e.target.value)}
                      placeholder="123 Maple Ridge Dr"
                    />
                  </Field>
                  <Field label="City">
                    <Input value={form.city} onChange={(e) => set("city", e.target.value)} />
                  </Field>
                  <Field label="Zip code">
                    <Input value={form.zip} onChange={(e) => set("zip", e.target.value)} />
                  </Field>
                  <Field label="Subdivision name">
                    <Input
                      value={form.subdivision}
                      onChange={(e) => set("subdivision", e.target.value)}
                    />
                  </Field>
                  <div className="grid grid-cols-2 gap-4">
                    <Field label="Block number">
                      <Input value={form.block} onChange={(e) => set("block", e.target.value)} />
                    </Field>
                    <Field label="Lot number">
                      <Input value={form.lot} onChange={(e) => set("lot", e.target.value)} />
                    </Field>
                  </div>
                </div>
              </Section>

              {selected.caw && (
                <>
                  <Section title="CAW — service details">
                    <p className="text-xs text-muted -mt-2 mb-3">
                      Land use, type of service, and building type are always Single-Family
                      Residence / Single Family Residence / House for new construction.
                    </p>
                    <div className="grid sm:grid-cols-2 gap-4">
                      <Field label="Square footage" hint={`Meter is 5/8" unless over ${METER_PROMPT_SQFT.toLocaleString()} sq ft.`}>
                        <Input
                          value={form.squareFootage}
                          onChange={(e) => set("squareFootage", e.target.value)}
                          placeholder="e.g. 2800"
                          inputMode="numeric"
                        />
                      </Field>
                      <Field label="Requested meter size" error={meterWarning ? "Home is over 4,000 sq ft — confirm meter size." : undefined}>
                        <Select
                          value={form.meterSize}
                          onChange={(e) => set("meterSize", e.target.value as MeterSize)}
                          invalid={meterWarning}
                        >
                          {METER_SIZES.map((m) => (
                            <option key={m} value={m}>
                              {m}&quot;
                            </option>
                          ))}
                        </Select>
                      </Field>
                      <YesNoField
                        label="Existing water service to this site?"
                        value={form.existingWaterService}
                        onChange={(v) => set("existingWaterService", v)}
                      />
                      <Field label="# existing buildings (excl. storage/garages)">
                        <Input
                          value={form.existingBuildings}
                          onChange={(e) => set("existingBuildings", e.target.value)}
                          inputMode="numeric"
                        />
                      </Field>
                      <Field label="# new buildings (excl. storage/garages)">
                        <Input
                          value={form.newBuildings}
                          onChange={(e) => set("newBuildings", e.target.value)}
                          inputMode="numeric"
                        />
                      </Field>
                      <YesNoField
                        label="Multi-story structure?"
                        value={form.multiStory}
                        onChange={(v) => set("multiStory", v)}
                      />
                      {form.multiStory && (
                        <Field label="How many floors?">
                          <Input value={form.floors} onChange={(e) => set("floors", e.target.value)} inputMode="numeric" />
                        </Field>
                      )}
                      <YesNoField
                        label="Multi-family residence?"
                        value={form.multiFamily}
                        onChange={(v) => set("multiFamily", v)}
                      />
                      {form.multiFamily && (
                        <Field label="Units served per meter">
                          <Input
                            value={form.unitsPerMeter}
                            onChange={(e) => set("unitsPerMeter", e.target.value)}
                            inputMode="numeric"
                          />
                        </Field>
                      )}
                      <YesNoField
                        label="Septic tank for wastewater?"
                        value={form.septicTank}
                        onChange={(v) => set("septicTank", v)}
                      />
                      <YesNoField
                        label="Connected to public sewer?"
                        value={form.publicSewer}
                        onChange={(v) => set("publicSewer", v)}
                      />
                    </div>
                    <Field label="Remarks" className="mt-4">
                      <Textarea value={form.remarks} onChange={(e) => set("remarks", e.target.value)} />
                    </Field>
                    <label className="mt-4 flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={form.includeStandpipe}
                        onChange={(e) => set("includeStandpipe", e.target.checked)}
                        className="h-4 w-4 rounded border-border-strong"
                      />
                      Include temporary construction standpipe ($65) — adds the standpipe agreement.
                    </label>
                  </Section>

                  <Section title="CAW — applicant (account holder)">
                    <p className="text-xs text-muted -mt-2 mb-3">
                      New construction water service is applied for in the builder&apos;s name. This is
                      constant — set it once in the app config.
                    </p>
                    <dl className="grid sm:grid-cols-2 gap-x-6 gap-y-1 text-sm">
                      <Row label="Company" value={data.builder.companyName} />
                      <Row label="Preparer" value={data.builder.preparerName} />
                      <Row label="Phone" value={data.builder.phone} />
                      <Row label="Email" value={data.builder.email} />
                      <Row label="Mailing address" value={data.builder.mailingAddress} />
                      <Row label="TIN / EIN" value={data.builder.tinSet ? "•••• (set)" : "Not set"} />
                    </dl>
                  </Section>
                </>
              )}

              {selected.lumber && (
                <Section title="Lumber One — job set-up">
                  <p className="text-xs text-muted -mt-2 mb-3">
                    Customer is {data.builder.companyName}; job type is always
                    Residential / New Construction. Salesperson initials, account
                    number, and estimated sales stay blank — Brad fills those in.
                  </p>
                  <div className="grid sm:grid-cols-2 gap-4">
                    <Field label="Job name" hint="Pre-filled with the street address.">
                      <Input
                        value={lumber.jobName}
                        onChange={(e) => setL("jobName", e.target.value)}
                      />
                    </Field>
                    <Field label="County" hint="Looked up from the job's city.">
                      <Input
                        value={lumber.county}
                        onChange={(e) => setL("county", e.target.value)}
                      />
                    </Field>
                    <YesNoField
                      label="In city limits?"
                      value={lumber.inCityLimits}
                      onChange={(v) => setL("inCityLimits", v)}
                    />
                    <Field
                      label="Property owner"
                      hint="Hines Homes when we own the lot; otherwise the client."
                    >
                      <Input
                        value={lumber.propertyOwner}
                        onChange={(e) => setL("propertyOwner", e.target.value)}
                      />
                    </Field>
                  </div>
                  <Field
                    label="Delivery directions, truck requirements/restrictions, special instructions"
                    hint="Stonebrook jobs auto-add the gate code."
                    className="mt-4"
                  >
                    <Textarea
                      value={lumber.deliveryDirections}
                      onChange={(e) => setL("deliveryDirections", e.target.value)}
                    />
                  </Field>
                </Section>
              )}

              {generated.length > 0 && (
                <div className="rounded-md border border-border bg-background/50 px-4 py-3">
                  <div className="text-sm font-medium mb-2 flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 text-success" /> Generated — review before sending
                  </div>
                  <ul className="space-y-1">
                    {generated.map((f) => (
                      <li key={f.filename} className="flex items-center gap-2">
                        <a
                          href={f.url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-sm text-brand-600 hover:underline inline-flex items-center gap-1"
                        >
                          <FileDown className="h-3.5 w-3.5" /> {f.filename}
                        </a>
                        <Badge tone="muted">{f.provider === "caw" ? "CAW" : "Lumber One"}</Badge>
                      </li>
                    ))}
                  </ul>
                  <div className="mt-3 pt-3 border-t border-border text-xs text-muted">
                    {selected.caw && (
                      <div>
                        CAW forms go to{" "}
                        <span className="font-medium text-foreground">{data.cawSubmissionEmail}</span>.
                      </div>
                    )}
                    {selected.lumber && (
                      <div>
                        The Lumber One form goes to{" "}
                        <span className="font-medium text-foreground">{data.lumberSubmissionEmail}</span>.
                      </div>
                    )}
                    <div className="mt-1">You&apos;re CC&apos;d on every email, and replies come back to you.</div>
                  </div>
                </div>
              )}

              <div className="flex flex-wrap items-center gap-2 pt-1">
                <Button variant="secondary" onClick={handleSave} disabled={pending}>
                  Save draft
                </Button>
                <Button variant="outline" onClick={handleGenerate} disabled={pending}>
                  {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  Generate &amp; preview
                </Button>
                <Button onClick={handleSend} disabled={pending || !canSend}>
                  <Send className="h-4 w-4" /> {sendLabel}
                </Button>
                {selected.caw && !data.cawConfigured && generated.length > 0 && (
                  <span className="text-xs text-warning">
                    Configure builder details to enable sending.
                  </span>
                )}
              </div>
            </>
          )}
        </CardBody>
      </Card>

      <h2 className="text-sm font-semibold text-muted uppercase tracking-wide mb-3">
        Requests
      </h2>
      {data.requests.length === 0 ? (
        <EmptyState
          icon={<Droplets className="h-8 w-8" />}
          title="No utility requests yet"
          description="Pick a job above and generate the CAW and Lumber One forms to get started."
        />
      ) : (
        <div className="space-y-3">
          {data.requests.map((r) => (
            <RequestCard
              key={r.id}
              req={r}
              paymentUrl={data.paymentUrl}
              onAdvance={advance}
              onContinue={handleContinue}
              onDelete={handleDelete}
              pending={pending}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-sm font-semibold text-foreground mb-3">{title}</h3>
      {children}
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className="text-foreground truncate">{value || "—"}</dd>
    </>
  )
}

function YesNoField({
  label,
  value,
  onChange,
}: {
  label: string
  value: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <Field label={label}>
      <Select value={value ? "yes" : "no"} onChange={(e) => onChange(e.target.value === "yes")}>
        <option value="no">No</option>
        <option value="yes">Yes</option>
      </Select>
    </Field>
  )
}

function RequestCard({
  req,
  paymentUrl,
  onAdvance,
  onContinue,
  onDelete,
  pending,
}: {
  req: UtilityRequestRow
  paymentUrl: string
  onAdvance: (id: string, status: "awaiting_payment" | "paid" | "complete") => void
  onContinue: (req: UtilityRequestRow) => void
  onDelete: (req: UtilityRequestRow) => void
  pending: boolean
}) {
  const addr =
    (req.form_data.serviceAddress as string) ||
    (req.form_data.streetAddress as string) ||
    (req.form_data.service_address as string) ||
    "—"
  const isLumber = req.provider === "lumber_one"
  return (
    <Card>
      <CardBody>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-medium truncate">{req.project_label}</span>
              <Badge tone={STATUS_TONE[req.status]}>{statusLabel(req)}</Badge>
            </div>
            <div className="text-sm text-muted mt-0.5 truncate">{addr}</div>
          </div>
          <Badge tone="muted">{PROVIDER_BADGE[req.provider] ?? req.provider}</Badge>
        </div>

        {req.files.length > 0 && (
          <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1">
            {req.files.map((f) => (
              <li key={f.path}>
                <a
                  href={f.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sm text-brand-600 hover:underline inline-flex items-center gap-1"
                >
                  <FileDown className="h-3.5 w-3.5" /> {f.filename}
                </a>
              </li>
            ))}
          </ul>
        )}

        {req.status === "awaiting_payment" && req.payment_url && (
          <div className="mt-3 text-sm">
            Pay online:{" "}
            <a href={req.payment_url} target="_blank" rel="noreferrer" className="text-brand-600 hover:underline">
              {req.payment_url}
            </a>
          </div>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          {req.status === "draft" && (
            <Button size="sm" variant="outline" onClick={() => onContinue(req)} disabled={pending}>
              Continue
            </Button>
          )}
          {req.status === "submitted" && !isLumber && (
            <Button size="sm" variant="outline" onClick={() => onAdvance(req.id, "awaiting_payment")} disabled={pending}>
              Mark payment link received
            </Button>
          )}
          {req.status === "awaiting_payment" && (
            <Button size="sm" variant="outline" onClick={() => onAdvance(req.id, "paid")} disabled={pending}>
              Mark paid
            </Button>
          )}
          {req.status === "paid" && (
            <Button size="sm" variant="secondary" onClick={() => onAdvance(req.id, "complete")} disabled={pending}>
              Mark complete
            </Button>
          )}
          {!isLumber && paymentUrl && !req.payment_url && req.status === "submitted" && (
            <span className="text-xs text-muted">
              Once CAW emails the pay link, mark it received to surface the payment URL.
            </span>
          )}
          <button
            type="button"
            onClick={() => onDelete(req)}
            disabled={pending}
            className="ml-auto text-muted hover:text-danger p-1 cursor-pointer disabled:opacity-50"
            title="Delete request"
            aria-label={`Delete request for ${req.project_label}`}
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </CardBody>
    </Card>
  )
}

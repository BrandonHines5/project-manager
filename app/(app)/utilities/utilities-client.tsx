"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Droplets, FileDown, Send, Loader2, CheckCircle2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { EmptyState } from "@/components/ui/empty"
import { Field, Input, Select, Textarea } from "@/components/ui/input"
import {
  saveUtilityDraft,
  generateCawPdfs,
  sendCawForms,
  updateUtilityStatus,
} from "@/app/actions/utilities"

const METER_SIZES = ["5/8", "3/4", "1", "1 1/2", "2", "3", "4"] as const
type MeterSize = (typeof METER_SIZES)[number]
const METER_PROMPT_SQFT = 4000

export type UtilitiesData = {
  projects: {
    id: string
    project_number: string
    name: string
    address: string | null
    client_name: string | null
  }[]
  requests: UtilityRequestRow[]
  builder: {
    companyName: string
    email: string
    phone: string
    mailingAddress: string
    preparerName: string
    tinSet: boolean
  }
  configured: boolean
  paymentUrl: string
  submissionEmail: string
}

export type UtilityRequestRow = {
  id: string
  project_id: string
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

/** Rehydrate a saved draft's form_data into form state (defaults fill gaps). */
function formFromData(d: Record<string, unknown>): FormState {
  const base = emptyForm()
  const str = (k: string, fb: string) => (typeof d[k] === "string" ? (d[k] as string) : fb)
  const bool = (k: string, fb: boolean) => (typeof d[k] === "boolean" ? (d[k] as boolean) : fb)
  const meter = String(d.meterSize ?? base.meterSize)
  return {
    date: str("date", base.date),
    serviceAddress: str("serviceAddress", ""),
    city: str("city", ""),
    zip: str("zip", ""),
    subdivision: str("subdivision", ""),
    block: str("block", ""),
    lot: str("lot", ""),
    existingWaterService: bool("existingWaterService", false),
    existingBuildings: str("existingBuildings", "0"),
    newBuildings: str("newBuildings", "1"),
    multiStory: bool("multiStory", false),
    floors: str("floors", ""),
    multiFamily: bool("multiFamily", false),
    unitsPerMeter: str("unitsPerMeter", ""),
    septicTank: bool("septicTank", false),
    publicSewer: bool("publicSewer", true),
    squareFootage: str("squareFootage", ""),
    meterSize: (METER_SIZES as readonly string[]).includes(meter)
      ? (meter as MeterSize)
      : base.meterSize,
    remarks: str("remarks", ""),
    includeStandpipe: bool("includeStandpipe", true),
  }
}

/** Best-effort split of a single-line project address into street/city/zip. */
function parseAddress(addr: string | null): { street: string; city: string; zip: string } {
  if (!addr) return { street: "", city: "", zip: "" }
  const parts = addr.split(",").map((s) => s.trim()).filter(Boolean)
  const street = parts[0] ?? ""
  let city = parts.length >= 2 ? parts[1] : ""
  const zipMatch = addr.match(/\b(\d{5})(?:-\d{4})?\b/)
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
const STATUS_LABEL: Record<UtilityRequestRow["status"], string> = {
  draft: "Draft",
  submitted: "Submitted to CAW",
  awaiting_payment: "Awaiting payment",
  paid: "Paid",
  complete: "Complete",
}

export function UtilitiesClient({ data }: { data: UtilitiesData }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [projectId, setProjectId] = useState("")
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [form, setForm] = useState<FormState>(emptyForm())
  const [generated, setGenerated] = useState<{ filename: string; url: string }[]>([])

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => {
    setForm((f) => ({ ...f, [k]: v }))
    // Editing answers invalidates any generated PDFs — clear the previews so a
    // stale set can't be sent; the user must regenerate before "Send to CAW".
    setGenerated([])
  }

  const sqft = parseInt(form.squareFootage || "0", 10) || 0
  const meterWarning = sqft > METER_PROMPT_SQFT && form.meterSize === "5/8"

  function onSelectProject(id: string) {
    setProjectId(id)
    setCurrentId(null)
    setGenerated([])
    const p = data.projects.find((x) => x.id === id)
    const { street, city, zip } = parseAddress(p?.address ?? null)
    setForm((f) => ({ ...f, serviceAddress: street, city, zip }))
  }

  function resetForm() {
    setProjectId("")
    setCurrentId(null)
    setGenerated([])
    setForm(emptyForm())
  }

  function handleContinue(req: UtilityRequestRow) {
    setProjectId(req.project_id)
    setCurrentId(req.id)
    setForm(formFromData(req.form_data))
    setGenerated(req.files.map((f) => ({ filename: f.filename, url: f.url })))
    if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" })
  }

  async function ensureSaved(): Promise<string> {
    const { id } = await saveUtilityDraft({ id: currentId, project_id: projectId, form })
    setCurrentId(id)
    return id
  }

  function handleSave() {
    if (!projectId) return toast.error("Pick a job first.")
    startTransition(async () => {
      try {
        await ensureSaved()
        toast.success("Draft saved.")
        router.refresh()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Save failed.")
      }
    })
  }

  function handleGenerate() {
    if (!projectId) return toast.error("Pick a job first.")
    if (!form.serviceAddress.trim()) return toast.error("Service address is required.")
    startTransition(async () => {
      try {
        const id = await ensureSaved()
        const { files } = await generateCawPdfs({ requestId: id })
        setGenerated(files.map((f) => ({ filename: f.filename, url: f.url })))
        toast.success(`Generated ${files.length} form${files.length === 1 ? "" : "s"}.`)
        router.refresh()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Generation failed.")
      }
    })
  }

  function handleSend() {
    if (!currentId) return toast.error("Generate the forms first.")
    if (!generated.length) return toast.error("Generate the forms first.")
    startTransition(async () => {
      try {
        const res = await sendCawForms({ requestId: currentId })
        if (res.sent) {
          toast.success(`Emailed to ${data.submissionEmail}.`)
          resetForm()
          router.refresh()
        } else {
          toast.error(res.reason ?? "Could not send.")
        }
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Send failed.")
      }
    })
  }

  function advance(id: string, status: "awaiting_payment" | "paid" | "complete") {
    startTransition(async () => {
      try {
        await updateUtilityStatus({ requestId: id, status })
        router.refresh()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Update failed.")
      }
    })
  }

  const canSend = !!currentId && generated.length > 0 && data.configured

  return (
    <div className="px-4 md:px-6 py-5 max-w-5xl">
      <div className="mb-5">
        <h1 className="text-lg font-semibold flex items-center gap-2">
          <Droplets className="h-5 w-5 text-brand-600" />
          Initiate Utilities
        </h1>
        <p className="text-sm text-muted mt-0.5">
          Pick a job to pre-fill the provider&apos;s forms, answer a few questions, then
          generate and email them. Phase 1 covers Central Arkansas Water (CAW).
        </p>
      </div>

      {!data.configured && (
        <div className="mb-5 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          CAW builder details aren&apos;t filled in yet (company name, TIN, phone, email,
          mailing address). You can generate and preview forms, but sending to CAW is
          disabled until those are set in the app config.
        </div>
      )}

      <Card className="mb-6">
        <CardHeader className="flex items-center justify-between">
          <CardTitle>New CAW request</CardTitle>
          <Badge tone="info">Central Arkansas Water</Badge>
        </CardHeader>
        <CardBody className="space-y-5">
          <div className="grid sm:grid-cols-2 gap-4">
            <Field label="Provider">
              <Select value="central_arkansas_water" disabled>
                <option value="central_arkansas_water">Central Arkansas Water</option>
              </Select>
            </Field>
            <Field label="Job" hint="Selecting a job pre-fills the service address.">
              <Select value={projectId} onChange={(e) => onSelectProject(e.target.value)}>
                <option value="">Choose a job…</option>
                {data.projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.project_number} — {p.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          {projectId && (
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

              <Section title="Service details">
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

              <Section title="Applicant (account holder)">
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

              {generated.length > 0 && (
                <div className="rounded-md border border-border bg-background/50 px-4 py-3">
                  <div className="text-sm font-medium mb-2 flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 text-green-600" /> Generated — review before sending
                  </div>
                  <ul className="space-y-1">
                    {generated.map((f) => (
                      <li key={f.filename}>
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
                  <Send className="h-4 w-4" /> Send to CAW
                </Button>
                {!data.configured && generated.length > 0 && (
                  <span className="text-xs text-amber-700">
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
          description="Pick a job above and generate the CAW forms to get started."
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
  pending,
}: {
  req: UtilityRequestRow
  paymentUrl: string
  onAdvance: (id: string, status: "awaiting_payment" | "paid" | "complete") => void
  onContinue: (req: UtilityRequestRow) => void
  pending: boolean
}) {
  const addr =
    (req.form_data.serviceAddress as string) ||
    (req.form_data.service_address as string) ||
    "—"
  return (
    <Card>
      <CardBody>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-medium truncate">{req.project_label}</span>
              <Badge tone={STATUS_TONE[req.status]}>{STATUS_LABEL[req.status]}</Badge>
            </div>
            <div className="text-sm text-muted mt-0.5 truncate">{addr}</div>
          </div>
          <Badge tone="muted">CAW</Badge>
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
          {req.status === "submitted" && (
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
          {paymentUrl && !req.payment_url && req.status === "submitted" && (
            <span className="text-xs text-muted">
              Once CAW emails the pay link, mark it received to surface the payment URL.
            </span>
          )}
        </div>
      </CardBody>
    </Card>
  )
}

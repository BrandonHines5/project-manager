"use client"

// Site walkthrough capture on the project Onsite tab. The PM walks the job
// dictating voice-memo segments (start/stop as needed) and snapping photos;
// Submit hands the transcript to the AI field-notes agent scoped to this
// project, and every suggested update comes back for per-item review before
// anything is written or sent. Photos ride the daily-log mutation and are
// attached server-side.
//
// Resilience: segments + uploaded photo paths persist to localStorage per
// project, so a dead tab on the jobsite loses nothing that finished
// uploading. Voice uses the same Web Speech dictation as the global AI
// dialog — on browsers without it (Firefox), typed notes are the flow.

import { useEffect, useRef, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import {
  Mic,
  Square,
  Plus,
  Trash2,
  Camera,
  X,
  Loader2,
  Sparkles,
  AlertTriangle,
  RotateCcw,
  MessageSquare,
  HelpCircle,
} from "lucide-react"
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Textarea, Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { createSupabaseBrowserClient } from "@/lib/supabase/client"
import { downscalePhoto } from "@/lib/images/downscale"
import { useScreenWakeLock } from "@/lib/hooks/use-wake-lock"
import {
  getSpeechRecognitionCtor,
  type SpeechRecognitionLike,
} from "@/lib/speech/web-speech"
import { runAgentTurnAction, applyPlanAction } from "@/app/actions/ai-agent"
import { getSignedUrls } from "@/app/actions/daily-logs"
import {
  isDestructive,
  type ProposedMutation,
  type AgentTurnResult,
  type AppliedMutation,
} from "@/lib/ai/types"
import { PlanCard, AppliedCard } from "@/components/ai/plan-review"

type Segment = { id: string; text: string }
type Photo = {
  id: string
  storage_path: string
  file_name: string
  file_type: string
  file_size: number
  caption: string
  // Object URL for fresh uploads; signed URL after a draft restore; null
  // while the signed URL is loading.
  preview_url: string | null
}
type FailedUpload = { id: string; file: File; error: string }
type Message = { role: "user" | "assistant"; content: string }

// What a failed step left behind, so the error state can offer recovery
// instead of a dead end: a failed turn can re-run with the same messages
// (proposals only — safe to retry), a failed apply returns to the reviewed
// plan (retrying blind could double-apply, so the user re-confirms).
type PlanState = {
  plan_id: string
  summary: string
  mutations: ProposedMutation[]
  incomplete?: "max_tokens" | "iteration_cap"
}

type ErrorRetry =
  | { kind: "turn"; messages: Message[] }
  | ({ kind: "plan" } & PlanState)

type Phase =
  | { kind: "capture" }
  | { kind: "thinking" }
  | { kind: "question"; question: string }
  | ({ kind: "plan" } & PlanState)
  | { kind: "applying" }
  | { kind: "applied"; results: AppliedMutation[]; draftKept: boolean }
  | { kind: "error"; message: string; retry: ErrorRetry | null }

// Persisted per project. Photos are only added here AFTER their upload
// succeeded — a File object can't be serialized, so anything still in
// flight (or failed) is lost on reload, and the retry chip says so.
type WalkthroughDraft = {
  v: 1
  project_id: string
  date: string // local YYYY-MM-DD when last edited
  segments: Segment[]
  photos: Omit<Photo, "preview_url">[]
}

const draftStorageKey = (projectId: string) => `onsite-walkthrough:${projectId}`
// Local calendar date — same en-CA idiom as the AI dialog, so "today" in
// dictated notes means the user's day, not UTC's.
const todayLocal = () => new Date().toLocaleDateString("en-CA")
const newId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2)

// Keep the composed message under the server's 20k cap with headroom.
const MAX_TRANSCRIPT_CHARS = 19000

// iOS Safari reports a fetch killed mid-flight (screen locked, app switched,
// WiFi→LTE handoff) as the bare "Load failed"; Chrome says "Failed to
// fetch". Translate to something a PM standing on a slab can act on.
function friendlyError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  if (/load failed|failed to fetch|network\s?error|fetch failed/i.test(raw)) {
    return "The connection dropped while working — a locked screen or weak signal can cause this. Your notes and photos are safe on this device."
  }
  return raw
}

export function Walkthrough({
  projectId,
  projectName,
}: {
  projectId: string
  projectName: string
}) {
  const router = useRouter()
  const [phase, setPhase] = useState<Phase>({ kind: "capture" })
  const [segments, setSegments] = useState<Segment[]>([])
  const [photos, setPhotos] = useState<Photo[]>([])
  const [failedUploads, setFailedUploads] = useState<FailedUpload[]>([])
  const [uploadingCount, setUploadingCount] = useState(0)
  const [messages, setMessages] = useState<Message[]>([])
  const [answerDraft, setAnswerDraft] = useState("")
  // Per-row selection for the plan phase (parallel to plan.mutations).
  const [checked, setChecked] = useState<boolean[]>([])
  // Two-tap confirm when destructive rows are checked: first tap arms,
  // second applies. Disarmed by any checkbox change.
  const [confirmArmed, setConfirmArmed] = useState(false)
  const [staleDraft, setStaleDraft] = useState<WalkthroughDraft | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const [listening, setListening] = useState(false)
  const [interim, setInterim] = useState("")
  const [speechSupported, setSpeechSupported] = useState(false)
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null)
  const transcriptRef = useRef("")
  const fileInputRef = useRef<HTMLInputElement>(null)
  const hydratedRef = useRef(false)

  // Keep the screen awake while dictating or waiting on the AI/apply round
  // trip. iPhones auto-lock at ~30s idle and iOS kills the in-flight fetch
  // when they do — the walkthrough's biggest real-world failure mode.
  useScreenWakeLock(pending || listening)

  // One-time hydration: feature-detect dictation and restore any saved
  // draft for this project. A draft from a previous day isn't merged
  // silently — the user chooses Resume or Discard first. SSR markup renders
  // the empty capture state, so there's no mismatch — this fills it in
  // client-side.
  useEffect(() => {
    setSpeechSupported(!!getSpeechRecognitionCtor())
    try {
      const raw = localStorage.getItem(draftStorageKey(projectId))
      if (raw) {
        const draft = JSON.parse(raw) as WalkthroughDraft
        if (
          draft.v === 1 &&
          draft.project_id === projectId &&
          (draft.segments.length > 0 || draft.photos.length > 0)
        ) {
          if (draft.date === todayLocal()) {
            restoreDraft(draft)
          } else {
            setStaleDraft(draft)
          }
        }
      }
    } catch {
      // Corrupt or unavailable storage — start fresh.
    }
    hydratedRef.current = true
  }, [projectId])

  // Persist the draft on every content change (post-hydration, and not
  // while a stale draft is still awaiting the Resume/Discard decision —
  // we must not clobber it).
  useEffect(() => {
    if (!hydratedRef.current || staleDraft) return
    try {
      const key = draftStorageKey(projectId)
      if (segments.length === 0 && photos.length === 0) {
        localStorage.removeItem(key)
      } else {
        const draft: WalkthroughDraft = {
          v: 1,
          project_id: projectId,
          date: todayLocal(),
          segments,
          photos: photos.map((p) => ({
            id: p.id,
            storage_path: p.storage_path,
            file_name: p.file_name,
            file_type: p.file_type,
            file_size: p.file_size,
            caption: p.caption,
          })),
        }
        localStorage.setItem(key, JSON.stringify(draft))
      }
    } catch {
      // Best-effort — the in-memory state is still the working copy.
    }
  }, [segments, photos, projectId, staleDraft])

  // Don't leave the mic hot if the user navigates away.
  useEffect(() => () => recognitionRef.current?.stop(), [])

  function restoreDraft(draft: WalkthroughDraft) {
    setSegments(draft.segments)
    setPhotos(draft.photos.map((p) => ({ ...p, preview_url: null })))
    const paths = draft.photos.map((p) => p.storage_path)
    if (paths.length > 0) {
      // Re-sign the stored paths so thumbnails render again.
      getSignedUrls(paths)
        .then((map) => {
          setPhotos((prev) =>
            prev.map((p) =>
              p.preview_url ? p : { ...p, preview_url: map[p.storage_path] ?? null }
            )
          )
        })
        .catch(() => {
          // Thumbnails stay as placeholders; the paths are still valid.
        })
    }
  }

  // ---- Voice segments -------------------------------------------------

  function toggleRecording() {
    // The ref — not `listening` — is the source of truth (same double-tap
    // guard as the AI dialog's dictation).
    if (recognitionRef.current) {
      recognitionRef.current.stop()
      return
    }
    const Ctor = getSpeechRecognitionCtor()
    if (!Ctor) return
    const rec = new Ctor()
    rec.lang = navigator.language || "en-US"
    rec.continuous = true
    rec.interimResults = true
    transcriptRef.current = ""
    rec.onresult = (event) => {
      let transcript = ""
      for (let i = 0; i < event.results.length; i++) {
        transcript += event.results[i][0].transcript
      }
      transcriptRef.current = transcript
      setInterim(transcript)
    }
    rec.onend = () => {
      // The single finalization path — fires for the user's stop tap AND
      // for iOS Safari's silence auto-stop, so a surprise stop just ends
      // the segment cleanly and the button reads "record" again.
      if (recognitionRef.current === rec) {
        recognitionRef.current = null
        setListening(false)
        const text = transcriptRef.current.trim()
        transcriptRef.current = ""
        setInterim("")
        if (text) {
          setSegments((prev) => [...prev, { id: newId(), text }])
        }
      }
    }
    rec.onerror = (event) => {
      // onend fires after onerror in every implementation — cleanup happens
      // there. Here we just explain the failure, which otherwise looks like
      // the mic silently giving up (likely on a fresh permission prompt).
      const code = event.error ?? ""
      if (code === "not-allowed" || code === "service-not-allowed") {
        setNotice(
          "Microphone access is blocked — allow it in your browser settings, or type your notes instead."
        )
      } else if (code !== "no-speech" && code !== "aborted") {
        setNotice("Voice recording hit a problem — your other notes are safe. Try again or type instead.")
      }
    }
    recognitionRef.current = rec
    setListening(true)
    setNotice(null)
    try {
      rec.start()
    } catch {
      if (recognitionRef.current === rec) {
        recognitionRef.current = null
        setListening(false)
      }
    }
  }

  function updateSegment(id: string, text: string) {
    setSegments((prev) => prev.map((s) => (s.id === id ? { ...s, text } : s)))
  }
  function removeSegment(id: string) {
    setSegments((prev) => prev.filter((s) => s.id !== id))
  }
  function addTypedSegment() {
    setSegments((prev) => [...prev, { id: newId(), text: "" }])
  }

  // ---- Photos ----------------------------------------------------------

  async function onPickFiles(files: FileList | null) {
    if (!files || files.length === 0) return
    const list = Array.from(files)
    if (fileInputRef.current) fileInputRef.current.value = ""
    await uploadFiles(list)
  }

  async function uploadFiles(files: File[]) {
    setUploadingCount((c) => c + files.length)
    const supabase = createSupabaseBrowserClient()
    // Concurrent per-file pipelines — on jobsite LTE a sequential loop would
    // make a 6-photo batch take 6x as long. Each file handles its own
    // success/failure, so one bad photo never blocks the rest.
    await Promise.all(
      files.map(async (file) => {
        try {
          const { blob, fileType } = await downscalePhoto(file)
          const ext =
            fileType === "image/jpeg"
              ? "jpg"
              : (file.name.split(".").pop()?.toLowerCase() ?? "bin")
          // Same key scheme as the daily-log drawer, so these photos are
          // managed (and cleaned up on delete) exactly like drawer uploads.
          const path = `projects/${projectId}/daily-logs/${Date.now()}-${Math.random()
            .toString(36)
            .slice(2, 8)}.${ext}`
          const { error } = await supabase.storage
            .from("project-files")
            .upload(path, blob, {
              cacheControl: "3600",
              upsert: false,
              contentType: fileType,
            })
          if (error) throw new Error(error.message)
          setPhotos((prev) => [
            ...prev,
            {
              id: newId(),
              storage_path: path,
              file_name: file.name,
              file_type: fileType,
              file_size: blob.size,
              caption: "",
              preview_url: URL.createObjectURL(blob),
            },
          ])
        } catch (e) {
          setFailedUploads((prev) => [
            ...prev,
            {
              id: newId(),
              file,
              error: e instanceof Error ? e.message : "upload failed",
            },
          ])
        } finally {
          setUploadingCount((c) => c - 1)
        }
      })
    )
  }

  function retryUpload(f: FailedUpload) {
    setFailedUploads((prev) => prev.filter((x) => x.id !== f.id))
    void uploadFiles([f.file])
  }
  function discardFailedUpload(id: string) {
    setFailedUploads((prev) => prev.filter((x) => x.id !== id))
  }

  function removePhoto(photo: Photo) {
    setPhotos((prev) => prev.filter((p) => p.id !== photo.id))
    if (photo.preview_url?.startsWith("blob:")) {
      URL.revokeObjectURL(photo.preview_url)
    }
    // Best-effort cleanup so an explicitly-removed photo doesn't linger in
    // the bucket. Failures are fine — it just becomes an unreferenced
    // object in a private bucket.
    void createSupabaseBrowserClient()
      .storage.from("project-files")
      .remove([photo.storage_path])
  }

  function updateCaption(id: string, caption: string) {
    setPhotos((prev) => prev.map((p) => (p.id === id ? { ...p, caption } : p)))
  }

  // ---- Submit → agent → review → apply ---------------------------------

  const nonEmptySegments = segments.filter((s) => s.text.trim())

  function composeMessage(): string {
    const parts: string[] = []
    if (nonEmptySegments.length > 0) {
      parts.push(
        `Site walkthrough notes from ${projectName}:\n\n` +
          nonEmptySegments.map((s) => `- ${s.text.trim()}`).join("\n")
      )
    } else {
      parts.push(
        `Site walkthrough at ${projectName} — no dictated notes, photos only.`
      )
    }
    if (photos.length > 0) {
      parts.push(
        `(${photos.length} photo${photos.length === 1 ? "" : "s"} from the walkthrough are already uploaded and will be attached to the daily log automatically — do not propose anything about them.)`
      )
    }
    return parts.join("\n\n")
  }

  const composedLength = composeMessage().length
  const canSubmit =
    (nonEmptySegments.length > 0 || photos.length > 0) &&
    uploadingCount === 0 &&
    failedUploads.length === 0 &&
    composedLength <= MAX_TRANSCRIPT_CHARS &&
    // Recording must be stopped first: the active segment only lands in
    // `segments` when onend fires, so submitting mid-dictation would
    // silently drop whatever is being said.
    !listening &&
    !pending

  function buildContext() {
    return {
      project_id: projectId,
      attachments: photos.map((p) => ({
        storage_path: p.storage_path,
        file_name: p.file_name,
        file_type: p.file_type || null,
        file_size: p.file_size ?? null,
        caption: p.caption.trim() || null,
      })),
    }
  }

  function runTurn(nextMessages: Message[]) {
    setPhase({ kind: "thinking" })
    startTransition(async () => {
      try {
        const result = await runAgentTurnAction({
          messages: nextMessages,
          today: todayLocal(),
          context: buildContext(),
        })
        handleResult(result, nextMessages)
      } catch (e) {
        // A turn only proposes — nothing was written or sent — so retrying
        // with the same messages is always safe.
        setPhase({
          kind: "error",
          message: friendlyError(e),
          retry: { kind: "turn", messages: nextMessages },
        })
      }
    })
  }

  function submit() {
    recognitionRef.current?.stop()
    setNotice(null)
    runTurn([{ role: "user", content: composeMessage() }])
  }

  function handleResult(result: AgentTurnResult, currentMessages: Message[]) {
    if (result.type === "error") {
      setPhase({
        kind: "error",
        message: result.message,
        retry: { kind: "turn", messages: currentMessages },
      })
      return
    }
    if (result.type === "question") {
      setMessages([
        ...currentMessages,
        { role: "assistant", content: result.question },
      ])
      setAnswerDraft("")
      setPhase({ kind: "question", question: result.question })
      return
    }
    if (result.mutations.length === 0) {
      // Rare — the field-notes prompt always proposes a daily log — but
      // don't dead-end if it happens.
      setNotice(
        result.summary ||
          "The AI couldn't find anything to update from those notes. Add detail and try again."
      )
      setMessages([])
      setPhase({ kind: "capture" })
      return
    }
    setMessages([
      ...currentMessages,
      { role: "assistant", content: result.summary || "Plan ready." },
    ])
    setChecked(result.mutations.map(() => true))
    setConfirmArmed(false)
    setPhase({
      kind: "plan",
      plan_id: result.plan_id,
      summary: result.summary,
      mutations: result.mutations,
      incomplete: result.incomplete,
    })
  }

  function answerQuestion() {
    const trimmed = answerDraft.trim()
    if (!trimmed) return
    runTurn([...messages, { role: "user", content: trimmed }])
  }

  function backToNotes() {
    setMessages([])
    setAnswerDraft("")
    setPhase({ kind: "capture" })
  }

  function toggleChecked(index: number) {
    setChecked((prev) => prev.map((c, i) => (i === index ? !c : c)))
    setConfirmArmed(false)
  }

  function applySelected(plan: PlanState) {
    const { plan_id, summary, mutations } = plan
    const selected = mutations.filter((_, i) => checked[i])
    if (selected.length === 0) return
    // On any failure, hand the reviewed plan back to the error state so the
    // user can return to it — regenerating it costs another AI run. The
    // plan_id is the idempotency key: a blind retry after a network error
    // returns the first apply's results instead of re-texting subs.
    const retry: ErrorRetry = { kind: "plan", ...plan }
    setPhase({ kind: "applying" })
    startTransition(async () => {
      try {
        const response = await applyPlanAction({
          mutations: selected,
          plan_id,
          summary,
        })
        if (!response.ok) {
          setPhase({ kind: "error", message: response.error, retry })
          return
        }
        const { results } = response
        const okCount = results.filter((r) => r.ok).length
        const failCount = results.length - okCount
        if (failCount === 0) {
          toast.success(`Applied ${okCount} change${okCount === 1 ? "" : "s"}`)
        } else {
          toast.error(`Applied ${okCount}, failed ${failCount}.`)
        }
        // The daily log carries the walkthrough record (and photos) — only
        // clear the on-device draft once it actually landed.
        const logApplied = results.some(
          (r) =>
            r.ok &&
            r.mutation.kind === "append_daily_log" &&
            r.mutation.project_id === projectId
        )
        if (logApplied) {
          setSegments([])
          setPhotos([])
          setMessages([])
        }
        setPhase({ kind: "applied", results, draftKept: !logApplied })
        router.refresh()
      } catch (e) {
        console.error("[walkthrough apply] unexpected failure:", e)
        setPhase({ kind: "error", message: friendlyError(e), retry })
      }
    })
  }

  function startNew() {
    setSegments([])
    setPhotos([])
    setFailedUploads([])
    setMessages([])
    setNotice(null)
    try {
      localStorage.removeItem(draftStorageKey(projectId))
    } catch {
      // ignore
    }
    setPhase({ kind: "capture" })
  }

  // ---- Render -----------------------------------------------------------

  return (
    <Card className="mb-6">
      <CardHeader className="flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-brand-500 shrink-0" />
        <div>
          <CardTitle>Site walkthrough</CardTitle>
          <p className="text-xs text-muted mt-0.5">
            Talk through the job and snap photos — AI drafts schedule updates,
            to-dos, texts, and the daily log for your review. Nothing happens
            until you approve it.
          </p>
        </div>
      </CardHeader>
      <CardBody className="space-y-4">
        {phase.kind === "capture" && staleDraft && (
          <StaleDraftBanner
            draft={staleDraft}
            onResume={() => {
              restoreDraft(staleDraft)
              setStaleDraft(null)
            }}
            onDiscard={() => {
              try {
                localStorage.removeItem(draftStorageKey(projectId))
              } catch {
                // ignore
              }
              setStaleDraft(null)
            }}
          />
        )}

        {phase.kind === "capture" && !staleDraft && (
          <>
            {notice && (
              <div className="rounded-md border border-border bg-background/60 px-3 py-2 text-sm text-muted">
                {notice}
              </div>
            )}

            {speechSupported ? (
              <Button
                type="button"
                variant={listening ? "danger" : "primary"}
                onClick={toggleRecording}
                className={cn("w-full h-14 text-base", listening && "animate-pulse")}
              >
                {listening ? (
                  <>
                    <Square className="h-5 w-5" />
                    Tap to stop
                  </>
                ) : (
                  <>
                    <Mic className="h-5 w-5" />
                    {segments.length > 0 ? "Record another note" : "Start recording"}
                  </>
                )}
              </Button>
            ) : (
              <div className="rounded-md border border-border bg-background/60 px-3 py-2 text-xs text-muted">
                Voice dictation isn&apos;t supported in this browser — add
                typed notes below instead.
              </div>
            )}

            {listening && (
              <div className="rounded-md border border-brand-500/40 bg-brand-500/5 px-3 py-2 text-sm min-h-[2.5rem] whitespace-pre-wrap">
                {interim || (
                  <span className="text-muted">Listening… talk now</span>
                )}
              </div>
            )}

            {segments.length > 0 && (
              <ul className="space-y-2">
                {segments.map((s, i) => (
                  <li key={s.id} className="flex items-start gap-2">
                    <Textarea
                      value={s.text}
                      onChange={(e) => updateSegment(s.id, e.target.value)}
                      rows={2}
                      placeholder={`Note ${i + 1}…`}
                      className="flex-1 text-sm"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => removeSegment(s.id)}
                      aria-label="Delete note"
                      className="mt-0.5 text-muted hover:text-danger"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}

            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={addTypedSegment}
              >
                <Plus className="h-3.5 w-3.5" />
                Add typed note
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploadingCount > 0}
              >
                {uploadingCount > 0 ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Camera className="h-3.5 w-3.5" />
                )}
                {uploadingCount > 0
                  ? `Uploading ${uploadingCount}…`
                  : "Add photos"}
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                capture="environment"
                multiple
                className="hidden"
                onChange={(e) => onPickFiles(e.target.files)}
              />
            </div>

            {failedUploads.length > 0 && (
              <ul className="space-y-1.5">
                {failedUploads.map((f) => (
                  <li
                    key={f.id}
                    className="flex items-center gap-2 rounded-md border border-danger/40 bg-red-50 px-3 py-1.5 text-xs text-danger"
                  >
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                    <span className="flex-1 min-w-0 truncate">
                      {f.file.name} failed — not saved on this device; retry
                      before leaving.
                    </span>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => retryUpload(f)}
                    >
                      <RotateCcw className="h-3 w-3" />
                      Retry
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => discardFailedUpload(f.id)}
                    >
                      Discard
                    </Button>
                  </li>
                ))}
              </ul>
            )}

            {photos.length > 0 && (
              <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                {photos.map((p) => (
                  <div key={p.id} className="space-y-1">
                    <div className="relative aspect-square rounded-md border border-border overflow-hidden bg-background">
                      {p.preview_url ? (
                        // eslint-disable-next-line @next/next/no-img-element -- signed/object URLs, not static assets
                        <img
                          src={p.preview_url}
                          alt={p.caption || p.file_name}
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <div className="h-full w-full flex items-center justify-center text-muted">
                          <Camera className="h-5 w-5" />
                        </div>
                      )}
                      <button
                        type="button"
                        onClick={() => removePhoto(p)}
                        aria-label="Remove photo"
                        className="absolute top-1 right-1 h-6 w-6 rounded-full bg-black/60 text-white flex items-center justify-center cursor-pointer"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    <Input
                      value={p.caption}
                      onChange={(e) => updateCaption(p.id, e.target.value)}
                      placeholder="Caption…"
                      className="h-9 sm:h-7 text-xs"
                    />
                  </div>
                ))}
              </div>
            )}

            {composedLength > MAX_TRANSCRIPT_CHARS && (
              <div className="text-xs text-danger">
                Notes are too long ({composedLength.toLocaleString()} of{" "}
                {MAX_TRANSCRIPT_CHARS.toLocaleString()} characters) — trim or
                submit this walkthrough and start another.
              </div>
            )}

            {/* Item 5 — recommend photos on job logs that have none. The
                walkthrough always writes a daily log; nudge (non-blocking) to
                add site photos before submitting when the user has notes but
                hasn't attached any. */}
            {nonEmptySegments.length > 0 &&
              photos.length === 0 &&
              uploadingCount === 0 && (
                <div className="rounded-md border border-amber-300/60 bg-amber-50/70 px-3 py-2 text-xs text-amber-800">
                  No photos yet — consider snapping a few before you submit. Photos
                  attach to this job&rsquo;s daily log and help show today&rsquo;s
                  progress.
                </div>
              )}

            <Button
              type="button"
              onClick={submit}
              disabled={!canSubmit}
              className="w-full h-12"
            >
              <Sparkles className="h-4 w-4" />
              Submit — review AI suggestions
            </Button>
          </>
        )}

        {phase.kind === "thinking" && (
          <div className="flex items-center gap-2 text-sm text-muted py-2">
            <Loader2 className="h-4 w-4 animate-spin" />
            Reading your walkthrough and drafting updates — keep this screen
            open, it can take up to a minute…
          </div>
        )}

        {phase.kind === "question" && (
          <div className="space-y-3">
            <div className="rounded-md border border-border bg-background px-3 py-2 text-sm">
              <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted mb-1">
                <HelpCircle className="h-3 w-3" />
                The AI needs one answer first
              </div>
              <div className="whitespace-pre-wrap">{phase.question}</div>
            </div>
            <Textarea
              value={answerDraft}
              onChange={(e) => setAnswerDraft(e.target.value)}
              rows={2}
              placeholder="Type your answer…"
              disabled={pending}
            />
            <div className="flex gap-2">
              <Button
                type="button"
                onClick={answerQuestion}
                disabled={pending || !answerDraft.trim()}
                className="flex-1"
              >
                Answer
              </Button>
              <Button type="button" variant="secondary" onClick={backToNotes}>
                Back to notes
              </Button>
            </div>
          </div>
        )}

        {phase.kind === "plan" && (
          <div className="space-y-3">
            {phase.summary && (
              <div className="rounded-md border border-border bg-background px-3 py-2 text-sm whitespace-pre-wrap">
                {phase.summary}
              </div>
            )}
            <div className="text-xs text-muted">
              Uncheck anything you don&apos;t want. Nothing is applied or sent
              until you tap Apply.
            </div>
            <PlanCard
              mutations={phase.mutations}
              incomplete={phase.incomplete}
              selection={{ checked, onToggle: toggleChecked }}
            />
            <PlanActions
              mutations={phase.mutations}
              checked={checked}
              confirmArmed={confirmArmed}
              onArm={() => setConfirmArmed(true)}
              onApply={() => applySelected(phase)}
              onEditNotes={backToNotes}
              pending={pending}
            />
          </div>
        )}

        {phase.kind === "applying" && (
          <div className="flex items-center gap-2 text-sm text-muted py-2">
            <Loader2 className="h-4 w-4 animate-spin" />
            Applying…
          </div>
        )}

        {phase.kind === "applied" && (
          <div className="space-y-3">
            <AppliedCard results={phase.results} />
            {phase.draftKept && (
              <div className="rounded-md border border-border bg-background/60 px-3 py-2 text-xs text-muted">
                The daily-log entry wasn&apos;t applied, so your notes and
                photos are still saved on this device.
              </div>
            )}
            <Button type="button" variant="secondary" onClick={startNew}>
              Start a new walkthrough
            </Button>
          </div>
        )}

        {phase.kind === "error" && (
          <div className="space-y-3">
            <div className="rounded-md border border-danger/40 bg-red-50 px-3 py-2 text-sm text-danger">
              <div className="flex items-start gap-2">
                <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                <div>{phase.message}</div>
              </div>
            </div>
            {phase.retry?.kind === "plan" && (
              <div className="text-xs text-muted">
                If the connection dropped mid-apply, some changes may have
                already gone through — glance at the Schedule or Job Logs tab
                before applying again.
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              {phase.retry?.kind === "turn" && (
                <RetryTurnButton retry={phase.retry} onRetry={runTurn} />
              )}
              {phase.retry?.kind === "plan" && (
                <RetryPlanButton
                  retry={phase.retry}
                  onBackToReview={(plan) => {
                    setConfirmArmed(false)
                    setPhase({ kind: "plan", ...plan })
                  }}
                />
              )}
              <Button
                type="button"
                variant="secondary"
                onClick={() => setPhase({ kind: "capture" })}
              >
                Back to notes
              </Button>
            </div>
          </div>
        )}
      </CardBody>
    </Card>
  )
}

// Tiny wrappers so the retry payload is a typed prop — TS narrowing on
// phase.retry doesn't survive into an onClick closure.
function RetryTurnButton({
  retry,
  onRetry,
}: {
  retry: Extract<ErrorRetry, { kind: "turn" }>
  onRetry: (messages: Message[]) => void
}) {
  return (
    <Button type="button" onClick={() => onRetry(retry.messages)}>
      <RotateCcw className="h-4 w-4" />
      Try again
    </Button>
  )
}

function RetryPlanButton({
  retry,
  onBackToReview,
}: {
  retry: Extract<ErrorRetry, { kind: "plan" }>
  onBackToReview: (plan: PlanState) => void
}) {
  const { plan_id, summary, mutations, incomplete } = retry
  return (
    <Button
      type="button"
      onClick={() => onBackToReview({ plan_id, summary, mutations, incomplete })}
    >
      Back to review
    </Button>
  )
}

function StaleDraftBanner({
  draft,
  onResume,
  onDiscard,
}: {
  draft: WalkthroughDraft
  onResume: () => void
  onDiscard: () => void
}) {
  return (
    <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2.5 text-sm space-y-2">
      <div className="flex items-start gap-2">
        <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0 text-amber-600" />
        <div>
          You have an unsubmitted walkthrough from {draft.date} (
          {draft.segments.length} note
          {draft.segments.length === 1 ? "" : "s"}, {draft.photos.length} photo
          {draft.photos.length === 1 ? "" : "s"}).
        </div>
      </div>
      <div className="flex gap-2">
        <Button type="button" size="sm" onClick={onResume}>
          Resume
        </Button>
        <Button type="button" variant="secondary" size="sm" onClick={onDiscard}>
          Discard
        </Button>
      </div>
    </div>
  )
}

function PlanActions({
  mutations,
  checked,
  confirmArmed,
  onArm,
  onApply,
  onEditNotes,
  pending,
}: {
  mutations: ProposedMutation[]
  checked: boolean[]
  confirmArmed: boolean
  onArm: () => void
  onApply: () => void
  onEditNotes: () => void
  pending: boolean
}) {
  const selected = mutations.filter((_, i) => checked[i])
  const smsCount = selected.filter((m) => m.kind === "send_sms").length
  const hasDestructive = selected.some(isDestructive)
  // Per-item checkboxes already forced an explicit look at every row; the
  // residual risk on a phone is a fat-finger tap, so destructive plans get
  // a second confirming tap instead of the dialog's typed-"apply" gate.
  const needsArm = hasDestructive && !confirmArmed
  return (
    <div className="space-y-2">
      {confirmArmed && hasDestructive && (
        <div className="flex items-center gap-2 text-xs text-muted">
          <AlertTriangle className="h-3.5 w-3.5 text-amber-600 shrink-0" />
          This updates existing data
          {smsCount > 0 && (
            <>
              {" "}
              and sends {smsCount} text{smsCount === 1 ? "" : "s"}
            </>
          )}
          . Tap again to confirm.
        </div>
      )}
      <div className="flex gap-2">
        <Button
          type="button"
          onClick={needsArm ? onArm : onApply}
          disabled={pending || selected.length === 0}
          className="flex-1 h-11"
          variant={confirmArmed && hasDestructive ? "danger" : "primary"}
        >
          {confirmArmed && hasDestructive ? (
            <>
              <AlertTriangle className="h-4 w-4" />
              Tap again to apply {selected.length}
            </>
          ) : (
            <>
              <Sparkles className="h-4 w-4" />
              Apply {selected.length} change{selected.length === 1 ? "" : "s"}
              {smsCount > 0 && (
                <span className="inline-flex items-center gap-1 text-xs opacity-90">
                  <MessageSquare className="h-3 w-3" />
                  {smsCount} text{smsCount === 1 ? "" : "s"}
                </span>
              )}
            </>
          )}
        </Button>
        <Button type="button" variant="secondary" onClick={onEditNotes}>
          Edit notes
        </Button>
      </div>
    </div>
  )
}

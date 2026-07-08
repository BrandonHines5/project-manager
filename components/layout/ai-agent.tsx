"use client"

import { useCallback, useEffect, useRef, useState, useTransition } from "react"
import { useRouter, usePathname } from "next/navigation"
import { toast } from "sonner"
import {
  Sparkles,
  Send,
  Loader2,
  HelpCircle,
  AlertTriangle,
  Mic,
  MicOff,
  MapPin,
  X,
} from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogFooter,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import {
  runAgentTurnAction,
  applyPlanAction,
  getScopedProject,
} from "@/app/actions/ai-agent"
import {
  isDestructive,
  type ProposedMutation,
  type AgentTurnResult,
  type AppliedMutation,
} from "@/lib/ai/types"
import { PlanCard, AppliedCard } from "@/components/ai/plan-review"
import {
  getSpeechRecognitionCtor,
  type SpeechRecognitionLike,
} from "@/lib/speech/web-speech"
import { useScreenWakeLock } from "@/lib/hooks/use-wake-lock"

type Message = { role: "user" | "assistant"; content: string }

type Phase =
  | { kind: "compose" }
  | { kind: "thinking" }
  | { kind: "question"; question: string }
  | {
      kind: "plan"
      plan_id: string
      summary: string
      mutations: ProposedMutation[]
      incomplete?: "max_tokens" | "iteration_cap"
    }
  | { kind: "applying" }
  | { kind: "applied"; results: AppliedMutation[] }
  | { kind: "error"; message: string }

type ScopedProject = { id: string; name: string; project_number: string }

// Pull a project id out of a /projects/{uuid}/… route so the dialog can
// auto-scope to the project the user is viewing.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
function projectIdFromPath(path: string | null): string | null {
  if (!path) return null
  const m = path.match(/^\/projects\/([^/]+)/)
  if (!m) return null
  return UUID_RE.test(m[1]) ? m[1] : null
}

const STARTER_EXAMPLES = [
  "How do I set a schedule baseline?",
  "What's the difference between a change order and a selection?",
  "The tile guy says he will finish today",
  "The dumpster needs to be flipped — text the dumpster company",
  "Add 'Check that nails are picked up' to the framing to-do in every open project",
]

// `dark` restyles the trigger for the dark top bar; the dialog is a light
// overlay either way.
export function AIAgent({ dark = false }: { dark?: boolean }) {
  const router = useRouter()
  const pathname = usePathname()
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState<Message[]>([])
  const [draft, setDraft] = useState("")
  const [phase, setPhase] = useState<Phase>({ kind: "compose" })
  const [pending, startTransition] = useTransition()
  // Auto-scope: when opened from a project route, default all requests to
  // that project (mirrors the walkthrough's trusted-context model). The user
  // can clear the scope for a cross-project request.
  const [scopedProject, setScopedProject] = useState<ScopedProject | null>(null)
  const [scopeCleared, setScopeCleared] = useState(false)
  const activeScope = scopeCleared ? null : scopedProject
  // Typed confirmation gate for plans that include destructive mutations
  // (any update_*). User must type "apply" before the Apply button enables.
  // Reset whenever the phase transitions to a new plan.
  const [confirmText, setConfirmText] = useState("")
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Voice dictation via the Web Speech API — lets a PM talk to the agent
  // from a phone on the job site. Hidden when the browser doesn't support
  // it (the phone keyboard's mic key still works in the textarea).
  const [listening, setListening] = useState(false)
  const [speechSupported, setSpeechSupported] = useState(false)
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null)
  // Draft text present when dictation started — live transcripts are
  // appended after it so dictating never clobbers typed text.
  const dictationBaseRef = useRef("")
  // Don't leave the mic hot when the dialog closes.
  useEffect(() => {
    if (!open) recognitionRef.current?.stop()
  }, [open])

  // Phones auto-lock mid-turn and iOS kills the in-flight fetch when they
  // do — keep the screen awake while dictating or waiting on the agent.
  useScreenWakeLock(pending || listening)

  const stopDictation = useCallback(() => {
    recognitionRef.current?.stop()
  }, [])

  function toggleDictation() {
    // The ref — not `listening` — is the source of truth here: two taps
    // before React re-renders would both read a stale `listening === false`
    // and spawn a second recognizer over the active one.
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
    dictationBaseRef.current = draft.trim() ? draft.trimEnd() + " " : ""
    rec.onresult = (event) => {
      let transcript = ""
      for (let i = 0; i < event.results.length; i++) {
        transcript += event.results[i][0].transcript
      }
      setDraft(dictationBaseRef.current + transcript)
    }
    rec.onend = () => {
      // Only tear down if this instance is still the active one — a late
      // onend from a superseded recognizer must not break the live session.
      if (recognitionRef.current === rec) {
        recognitionRef.current = null
        setListening(false)
      }
    }
    rec.onerror = () => {
      // onend fires after onerror in every implementation — state resets there.
    }
    recognitionRef.current = rec
    setListening(true)
    try {
      rec.start()
    } catch {
      if (recognitionRef.current === rec) {
        recognitionRef.current = null
        setListening(false)
      }
    }
  }

  // Open with a clean slate. State changes happen in the event handler so
  // we don't trip the set-state-in-effect rule.
  const openDialog = useCallback(() => {
    setMessages([])
    setDraft("")
    setConfirmText("")
    setPhase({ kind: "compose" })
    setScopedProject(null)
    setScopeCleared(false)
    // If we're on a project route, resolve the project name for the scope
    // chip. RLS both authorizes the scope and supplies the display fields.
    const pid = projectIdFromPath(pathname)
    if (pid) {
      getScopedProject(pid)
        .then((p) => {
          if (p) setScopedProject(p)
        })
        .catch(() => {
          // Non-fatal — the dialog still works unscoped.
        })
    }
    // Feature-detect dictation here (not in an effect) — window isn't
    // available during SSR and this is the first moment we need to know.
    setSpeechSupported(!!getSpeechRecognitionCtor())
    setOpen(true)
    requestAnimationFrame(() => textareaRef.current?.focus())
  }, [pathname])
  const closeDialog = useCallback(() => setOpen(false), [])

  // Auto-scroll the transcript to the bottom when new content lands.
  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    })
  }, [messages, phase])

  function sendMessage(text: string) {
    const trimmed = text.trim()
    if (!trimmed) return
    stopDictation()
    const next: Message[] = [...messages, { role: "user", content: trimmed }]
    setMessages(next)
    setDraft("")
    setPhase({ kind: "thinking" })
    startTransition(async () => {
      try {
        const result = await runAgentTurnAction({
          messages: next,
          // en-CA formats as YYYY-MM-DD in the browser's local timezone, so
          // "today" in a dictated note means the user's today, not UTC's.
          today: new Date().toLocaleDateString("en-CA"),
          // Auto-scope to the project route we're on (page mode = no photos).
          ...(activeScope
            ? {
                context: {
                  project_id: activeScope.id,
                  attachments: [],
                  mode: "page" as const,
                },
              }
            : {}),
        })
        handleResult(result, next)
      } catch (e) {
        setPhase({
          kind: "error",
          message: e instanceof Error ? e.message : "Agent failed",
        })
      }
    })
  }

  function handleResult(result: AgentTurnResult, currentMessages: Message[]) {
    if (result.type === "error") {
      setPhase({ kind: "error", message: result.message })
      return
    }
    if (result.type === "question") {
      // Record the assistant's question into the transcript so the user can
      // see what they're answering, then move to the "question" phase.
      setMessages([
        ...currentMessages,
        { role: "assistant", content: result.question },
      ])
      setPhase({ kind: "question", question: result.question })
      requestAnimationFrame(() => textareaRef.current?.focus())
      return
    }
    // type === "plan"
    if (result.mutations.length === 0) {
      // The agent finished but had nothing to change. Surface the summary
      // as an assistant turn and let the user iterate.
      setMessages([
        ...currentMessages,
        {
          role: "assistant",
          content:
            result.summary || "I couldn't find anything to change for that request.",
        },
      ])
      setPhase({ kind: "compose" })
      return
    }
    setMessages([
      ...currentMessages,
      { role: "assistant", content: result.summary || "Plan ready." },
    ])
    setConfirmText("")
    setPhase({
      kind: "plan",
      plan_id: result.plan_id,
      summary: result.summary,
      mutations: result.mutations,
      incomplete: result.incomplete,
    })
  }

  function applyPlan() {
    if (phase.kind !== "plan") return
    const { mutations, plan_id, summary } = phase
    setPhase({ kind: "applying" })
    startTransition(async () => {
      try {
        const response = await applyPlanAction({ mutations, plan_id, summary })
        if (!response.ok) {
          // Validation / pre-flight failure — show the real reason in the
          // dialog. (Per-mutation failures during apply land in
          // response.results below as ok: false rows, not here.)
          setPhase({ kind: "error", message: response.error })
          return
        }
        const { results } = response
        setPhase({ kind: "applied", results })
        const okCount = results.filter((r) => r.ok).length
        const failCount = results.length - okCount
        if (response.alreadyApplied) {
          toast("This plan was already applied — no changes were repeated.")
        } else if (failCount === 0) {
          toast.success(`Applied ${okCount} change${okCount === 1 ? "" : "s"}`)
        } else {
          toast.error(
            `Applied ${okCount}, failed ${failCount}. Check the dialog for details.`
          )
        }
        router.refresh()
      } catch (e) {
        // Network / unexpected failure — server actions in production may
        // scrub the message; log whatever we have client-side too.
        console.error("[applyPlan] unexpected failure:", e)
        setPhase({
          kind: "error",
          message:
            e instanceof Error
              ? e.message
              : "Apply failed — open the dev tools console for details.",
        })
      }
    })
  }

  return (
    <>
      <button
        type="button"
        onClick={openDialog}
        className={cn(
          "inline-flex h-9 items-center gap-1.5 rounded-md border px-2.5 text-sm font-medium transition-colors cursor-pointer",
          dark
            ? "border-brand-500/70 bg-brand-500/25 text-white hover:bg-brand-500/40"
            : "border-brand-500 bg-brand-500/10 text-brand-700 hover:bg-brand-500/20"
        )}
        aria-label="Open AI assistant"
        title="AI assistant — help desk, reports & smart updates"
      >
        <Sparkles className="h-4 w-4" />
        <span className="hidden sm:inline">AI</span>
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent size="lg" className="sm:max-h-[85vh]">
          <DialogHeader>
            <div>
              <DialogTitle>
                <span className="inline-flex items-center gap-2">
                  <Sparkles className="h-4 w-4 text-brand-500" />
                  AI smart updates
                </span>
              </DialogTitle>
              <DialogDescription>
                Ask how the app works, ask about your jobs, or talk/type
                what&apos;s happening on site. Any schedule updates, texts, or
                to-dos are drafted for your review before anything happens.
              </DialogDescription>
            </div>
          </DialogHeader>
          <DialogBody className="p-0">
            <div
              ref={scrollRef}
              className="px-6 py-4 max-h-[55vh] overflow-y-auto space-y-3"
            >
              {activeScope && (
                <div className="flex items-center gap-1.5 rounded-md border border-brand-500/40 bg-brand-500/10 px-2.5 py-1.5 text-xs text-brand-700">
                  <MapPin className="h-3.5 w-3.5 shrink-0" />
                  <span className="min-w-0 truncate">
                    Scoped to <span className="font-medium">{activeScope.name}</span>{" "}
                    <span className="font-mono">#{activeScope.project_number}</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => setScopeCleared(true)}
                    className="ml-auto inline-flex h-5 w-5 items-center justify-center rounded hover:bg-brand-500/20 cursor-pointer"
                    aria-label="Clear project scope"
                    title="Clear scope (ask across all projects)"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
              {messages.length === 0 && phase.kind === "compose" && (
                <Starter onPick={(s) => setDraft(s)} />
              )}
              {messages.map((m, i) => (
                <Bubble key={i} role={m.role} text={m.content} />
              ))}
              {phase.kind === "thinking" && (
                <div className="flex items-center gap-2 text-sm text-muted">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Thinking…
                </div>
              )}
              {phase.kind === "plan" && (
                <PlanCard
                  mutations={phase.mutations}
                  incomplete={phase.incomplete}
                  className="max-h-72 overflow-y-auto"
                />
              )}
              {phase.kind === "applying" && (
                <div className="flex items-center gap-2 text-sm text-muted">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Applying…
                </div>
              )}
              {phase.kind === "applied" && (
                <AppliedCard results={phase.results} />
              )}
              {phase.kind === "error" && (
                <div className="rounded-md border border-danger/40 bg-red-50 px-3 py-2 text-sm text-danger">
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                    <div>{phase.message}</div>
                  </div>
                </div>
              )}
            </div>
          </DialogBody>
          {(phase.kind === "compose" ||
            phase.kind === "question" ||
            phase.kind === "applied" ||
            phase.kind === "error") && (
            <DialogFooter>
              <div className="flex w-full items-end gap-2">
                <div className="flex-1">
                  <Textarea
                    ref={textareaRef}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                        e.preventDefault()
                        sendMessage(draft)
                      }
                    }}
                    rows={2}
                    placeholder={
                      phase.kind === "question"
                        ? "Type your answer…"
                        : listening
                          ? "Listening… talk now"
                          : "Ask how something works, or say what's happening on site (⌘+Enter)"
                    }
                    disabled={pending}
                    className="min-h-[60px]"
                  />
                </div>
                {speechSupported && (
                  <Button
                    type="button"
                    variant={listening ? "danger" : "secondary"}
                    size="icon"
                    onClick={toggleDictation}
                    disabled={pending}
                    aria-label={
                      listening ? "Stop dictation" : "Dictate with your voice"
                    }
                    title={listening ? "Stop dictation" : "Dictate"}
                    className={listening ? "animate-pulse" : undefined}
                  >
                    {listening ? (
                      <MicOff className="h-4 w-4" />
                    ) : (
                      <Mic className="h-4 w-4" />
                    )}
                  </Button>
                )}
                <Button
                  type="button"
                  onClick={() => sendMessage(draft)}
                  disabled={pending || !draft.trim()}
                >
                  <Send className="h-4 w-4" />
                  Send
                </Button>
              </div>
            </DialogFooter>
          )}
          {phase.kind === "plan" && (
            <DialogFooter>
              <PlanFooter
                mutations={phase.mutations}
                confirmText={confirmText}
                onConfirmTextChange={setConfirmText}
                onCancel={closeDialog}
                onRefine={() => setPhase({ kind: "compose" })}
                onApply={applyPlan}
                pending={pending}
              />
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}

// The agent's ask_user clarifying question is one short sentence ending in a
// "?". A help-desk or reporting answer is longer prose (and may quote a
// question like "what's the difference…?") — don't mislabel those. Kept as a
// heuristic because the transcript stores only {role, content}, not intent.
function isClarifyingQuestion(text: string): boolean {
  const t = text.trim()
  return t.length < 160 && t.endsWith("?")
}

function Bubble({ role, text }: { role: "user" | "assistant"; text: string }) {
  const isUser = role === "user"
  return (
    <div
      className={cn(
        "flex",
        isUser ? "justify-end" : "justify-start"
      )}
    >
      <div
        className={cn(
          "max-w-[85%] rounded-md px-3 py-2 text-sm whitespace-pre-wrap",
          isUser
            ? "bg-brand-500 text-white"
            : "bg-background border border-border text-foreground"
        )}
      >
        {!isUser && (
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted mb-1">
            {isClarifyingQuestion(text) ? (
              <>
                <HelpCircle className="h-3 w-3" />
                Clarifying question
              </>
            ) : (
              <>
                <Sparkles className="h-3 w-3" />
                Assistant
              </>
            )}
          </div>
        )}
        {text}
      </div>
    </div>
  )
}

function Starter({ onPick }: { onPick: (s: string) => void }) {
  return (
    <div className="space-y-2 text-sm">
      <div className="text-muted">Try one of these to start:</div>
      <ul className="space-y-1.5">
        {STARTER_EXAMPLES.map((s) => (
          <li key={s}>
            <button
              type="button"
              onClick={() => onPick(s)}
              className="w-full text-left rounded-md border border-border bg-background/40 px-3 py-2 hover:bg-background hover:border-border-strong cursor-pointer"
            >
              <Sparkles className="inline h-3 w-3 mr-1.5 text-brand-500" />
              {s}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}


function PlanFooter({
  mutations,
  confirmText,
  onConfirmTextChange,
  onCancel,
  onRefine,
  onApply,
  pending,
}: {
  mutations: ProposedMutation[]
  confirmText: string
  onConfirmTextChange: (v: string) => void
  onCancel: () => void
  onRefine: () => void
  onApply: () => void
  pending: boolean
}) {
  const hasDestructive = mutations.some(isDestructive)
  const confirmed = !hasDestructive || confirmText.trim().toLowerCase() === "apply"
  return (
    <div className="flex w-full flex-col gap-2">
      {hasDestructive && (
        <div className="flex items-center gap-2 text-xs">
          <AlertTriangle className="h-3.5 w-3.5 text-amber-600 shrink-0" />
          <span className="text-muted">
            This plan modifies existing data or sends a text. Type{" "}
            <span className="font-mono font-medium">apply</span> to enable
            the button.
          </span>
          <input
            type="text"
            value={confirmText}
            onChange={(e) => onConfirmTextChange(e.target.value)}
            placeholder="type apply"
            aria-label="Type apply to confirm destructive changes"
            className="h-7 w-28 rounded-md border border-border-strong bg-surface px-2 text-xs font-mono focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
          />
        </div>
      )}
      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="button" variant="secondary" onClick={onRefine}>
          Refine prompt
        </Button>
        <Button
          type="button"
          onClick={onApply}
          disabled={pending || !confirmed}
        >
          <Sparkles className="h-4 w-4" />
          Apply {mutations.length} change
          {mutations.length === 1 ? "" : "s"}
        </Button>
      </div>
    </div>
  )
}


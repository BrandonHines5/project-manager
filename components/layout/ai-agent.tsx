"use client"

import { useCallback, useEffect, useRef, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import {
  Sparkles,
  Send,
  Loader2,
  CheckCircle2,
  XCircle,
  HelpCircle,
  Pencil,
  ListChecks,
  AlertTriangle,
  Plus,
  Calendar,
  Scale,
  Palette,
  Send as SendIcon,
  UserPlus,
  Mic,
  MicOff,
  MessageSquare,
  NotebookPen,
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
} from "@/app/actions/ai-agent"
import {
  isDestructive,
  type ProposedMutation,
  type AgentTurnResult,
  type AppliedMutation,
} from "@/lib/ai/types"

type Message = { role: "user" | "assistant"; content: string }

// Minimal Web Speech API surface. TypeScript's dom lib doesn't ship these
// declarations (the API is still vendor-prefixed in WebKit), so we declare
// just what the dictation button uses.
interface SpeechRecognitionLike {
  lang: string
  continuous: boolean
  interimResults: boolean
  start(): void
  stop(): void
  onresult:
    | ((event: {
        results: ArrayLike<{ 0: { transcript: string }; isFinal: boolean }>
      }) => void)
    | null
  onend: (() => void) | null
  onerror: ((event: { error?: string }) => void) | null
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike
declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionCtor
    webkitSpeechRecognition?: SpeechRecognitionCtor
  }
}

type Phase =
  | { kind: "compose" }
  | { kind: "thinking" }
  | { kind: "question"; question: string }
  | { kind: "plan"; summary: string; mutations: ProposedMutation[] }
  | { kind: "applying" }
  | { kind: "applied"; results: AppliedMutation[] }
  | { kind: "error"; message: string }

const STARTER_EXAMPLES = [
  "The tile guy says he will finish today",
  "The dumpster needs to be flipped — text the dumpster company",
  "I need to order more 2x4s",
  "Add 'Check that nails are picked up' to the framing to-do in every open project",
]

export function AIAgent() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState<Message[]>([])
  const [draft, setDraft] = useState("")
  const [phase, setPhase] = useState<Phase>({ kind: "compose" })
  const [pending, startTransition] = useTransition()
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
    const Ctor = window.SpeechRecognition ?? window.webkitSpeechRecognition
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
    // Feature-detect dictation here (not in an effect) — window isn't
    // available during SSR and this is the first moment we need to know.
    setSpeechSupported(
      !!(window.SpeechRecognition || window.webkitSpeechRecognition)
    )
    setOpen(true)
    requestAnimationFrame(() => textareaRef.current?.focus())
  }, [])
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
      summary: result.summary,
      mutations: result.mutations,
    })
  }

  function applyPlan() {
    if (phase.kind !== "plan") return
    const mutations = phase.mutations
    setPhase({ kind: "applying" })
    startTransition(async () => {
      try {
        const response = await applyPlanAction({ mutations })
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
        if (failCount === 0) {
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
        className="inline-flex h-9 items-center gap-1.5 rounded-md border border-brand-500 bg-brand-500/10 px-2.5 text-sm font-medium text-brand-700 hover:bg-brand-500/20 transition-colors cursor-pointer"
        aria-label="Open AI assistant"
        title="AI smart updates"
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
                Talk or type what&apos;s happening on site — schedule updates,
                texts to subs, to-dos, and a daily-log note are drafted for
                your review before anything happens.
              </DialogDescription>
            </div>
          </DialogHeader>
          <DialogBody className="p-0">
            <div
              ref={scrollRef}
              className="px-6 py-4 max-h-[55vh] overflow-y-auto space-y-3"
            >
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
                <PlanCard mutations={phase.mutations} />
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
                          : "What's happening on site? (⌘+Enter to send)"
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
            {text.toLowerCase().includes("?") ? (
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

function PlanCard({ mutations }: { mutations: ProposedMutation[] }) {
  return (
    <div className="rounded-md border border-border-strong bg-surface">
      <div className="px-3 py-2 border-b border-border bg-background/60 text-xs uppercase tracking-wide text-muted flex items-center gap-1.5">
        <ListChecks className="h-3.5 w-3.5" />
        Plan — {mutations.length} change{mutations.length === 1 ? "" : "s"}
      </div>
      <ul className="divide-y divide-border max-h-72 overflow-y-auto">
        {mutations.map((m, i) => (
          <li key={i} className="px-3 py-2 text-sm">
            <MutationRow mutation={m} />
          </li>
        ))}
      </ul>
    </div>
  )
}

function MutationRow({ mutation }: { mutation: ProposedMutation }) {
  // Project crumb shared by every row.
  const crumb = (parts: { project_name: string; project_number: string }) => (
    <div className="text-xs text-muted mt-0.5">
      {parts.project_name}{" "}
      {parts.project_number && (
        <span className="font-mono">#{parts.project_number}</span>
      )}
    </div>
  )

  switch (mutation.kind) {
    case "add_checklist_item":
      return (
        <RowFrame icon={<ListChecks className="h-3.5 w-3.5 text-brand-500" />}>
          <div className="font-medium">
            Add checklist item:{" "}
            <span className="font-mono text-xs">&ldquo;{mutation.label}&rdquo;</span>
          </div>
          <div className="text-xs text-muted mt-0.5">
            {mutation.context.item_title} · {mutation.context.project_name}{" "}
            {mutation.context.project_number && (
              <span className="font-mono">
                #{mutation.context.project_number}
              </span>
            )}
          </div>
        </RowFrame>
      )
    case "update_schedule_item_status":
      return (
        <RowFrame
          icon={<Pencil className="h-3.5 w-3.5 text-amber-600" />}
          destructive
        >
          <div className="font-medium">
            Set status:{" "}
            <span className="font-mono text-xs">
              {mutation.context.previous_status}
            </span>{" "}
            → <span className="font-mono text-xs">{mutation.status}</span>
          </div>
          <div className="text-xs text-muted mt-0.5">
            {mutation.context.item_title} · {mutation.context.project_name}{" "}
            {mutation.context.project_number && (
              <span className="font-mono">
                #{mutation.context.project_number}
              </span>
            )}
          </div>
        </RowFrame>
      )
    case "update_schedule_item":
      return (
        <RowFrame
          icon={<Pencil className="h-3.5 w-3.5 text-amber-600" />}
          destructive
        >
          <div className="font-medium">
            Update item: {mutation.context.item_title}
          </div>
          <ul className="text-xs mt-1 space-y-0.5">
            {mutation.context.changes.map((c, i) => (
              <li key={i} className="font-mono">
                {c}
              </li>
            ))}
          </ul>
          {crumb(mutation.context)}
        </RowFrame>
      )
    case "create_todo":
      return (
        <RowFrame icon={<Plus className="h-3.5 w-3.5 text-brand-500" />}>
          <div className="font-medium">
            New to-do: <span className="font-mono text-xs">{mutation.title}</span>
          </div>
          <div className="text-xs text-muted mt-0.5">
            {mutation.context.parent_title
              ? `under ${mutation.context.parent_title} · `
              : ""}
            {mutation.due_date && (
              <span>
                <Calendar className="inline h-3 w-3 mr-0.5" />
                {mutation.due_date} ·{" "}
              </span>
            )}
            {mutation.context.project_name}{" "}
            {mutation.context.project_number && (
              <span className="font-mono">
                #{mutation.context.project_number}
              </span>
            )}
          </div>
        </RowFrame>
      )
    case "create_work_item":
      return (
        <RowFrame icon={<Plus className="h-3.5 w-3.5 text-brand-500" />}>
          <div className="font-medium">
            New work item:{" "}
            <span className="font-mono text-xs">{mutation.title}</span>
          </div>
          <div className="text-xs text-muted mt-0.5">
            <Calendar className="inline h-3 w-3 mr-0.5" />
            {mutation.start_date} → {mutation.end_date} ·{" "}
            {mutation.context.project_name}{" "}
            {mutation.context.project_number && (
              <span className="font-mono">
                #{mutation.context.project_number}
              </span>
            )}
          </div>
        </RowFrame>
      )
    case "create_decision":
      return (
        <RowFrame
          icon={
            mutation.decision_kind === "change_order" ? (
              <Scale className="h-3.5 w-3.5 text-brand-500" />
            ) : (
              <Palette className="h-3.5 w-3.5 text-brand-500" />
            )
          }
        >
          <div className="font-medium">
            New{" "}
            {mutation.decision_kind === "change_order"
              ? "change order"
              : "selection"}
            : <span className="font-mono text-xs">{mutation.title}</span>
          </div>
          <div className="text-xs text-muted mt-0.5">
            (starts as draft) · {mutation.context.project_name}{" "}
            {mutation.context.project_number && (
              <span className="font-mono">
                #{mutation.context.project_number}
              </span>
            )}
          </div>
        </RowFrame>
      )
    case "update_decision_status":
      return (
        <RowFrame
          icon={<SendIcon className="h-3.5 w-3.5 text-amber-600" />}
          destructive
        >
          <div className="font-medium">
            Decision #{mutation.context.decision_number}: status{" "}
            <span className="font-mono text-xs">
              {mutation.context.previous_status}
            </span>{" "}
            → <span className="font-mono text-xs">{mutation.status}</span>
          </div>
          <div className="text-xs text-muted mt-0.5">
            {mutation.context.decision_title} · {mutation.context.project_name}{" "}
            {mutation.context.project_number && (
              <span className="font-mono">
                #{mutation.context.project_number}
              </span>
            )}
          </div>
        </RowFrame>
      )
    case "add_decision_followup":
      return (
        <RowFrame icon={<UserPlus className="h-3.5 w-3.5 text-brand-500" />}>
          <div className="font-medium">
            Add follow-up:{" "}
            <span className="font-mono text-xs">{mutation.title}</span>
          </div>
          <div className="text-xs text-muted mt-0.5">
            on Decision #{mutation.context.decision_number} (
            {mutation.context.decision_title}) · due{" "}
            {mutation.due_offset_days}d after approval
            {mutation.context.assignee_name &&
              ` · assigned to ${mutation.context.assignee_name}`}
          </div>
          {crumb(mutation.context)}
        </RowFrame>
      )
    case "append_daily_log":
      return (
        <RowFrame icon={<NotebookPen className="h-3.5 w-3.5 text-brand-500" />}>
          <div className="font-medium">
            Daily log note ({mutation.log_date})
            <span className="font-normal text-xs text-muted">
              {" "}
              —{" "}
              {mutation.context.appends_to_existing
                ? "adds to the existing log"
                : "starts a new internal log"}
            </span>
          </div>
          <div className="text-xs mt-1 whitespace-pre-wrap">
            {mutation.note}
          </div>
          {crumb(mutation.context)}
        </RowFrame>
      )
    case "send_sms":
      return (
        <RowFrame
          icon={<MessageSquare className="h-3.5 w-3.5 text-amber-600" />}
          destructive
        >
          <div className="font-medium">
            Text {mutation.context.company_name}{" "}
            <span className="font-mono text-xs">
              {mutation.context.company_phone}
            </span>
          </div>
          <div className="text-xs mt-1 whitespace-pre-wrap">
            &ldquo;{mutation.message}&rdquo;
          </div>
          {mutation.context.project_name && (
            <div className="text-xs text-muted mt-0.5">
              {mutation.context.project_name}{" "}
              {mutation.context.project_number && (
                <span className="font-mono">
                  #{mutation.context.project_number}
                </span>
              )}
            </div>
          )}
        </RowFrame>
      )
  }
}

function RowFrame({
  icon,
  children,
  destructive,
}: {
  icon: React.ReactNode
  children: React.ReactNode
  destructive?: boolean
}) {
  return (
    <div className="flex items-start gap-2">
      <div
        className={cn(
          "h-5 w-5 rounded flex items-center justify-center mt-0.5 shrink-0",
          destructive ? "bg-amber-100" : "bg-brand-100"
        )}
        title={destructive ? "Modifies existing data" : "Additive"}
      >
        {icon}
      </div>
      <div className="flex-1 min-w-0">{children}</div>
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

function AppliedCard({ results }: { results: AppliedMutation[] }) {
  const okCount = results.filter((r) => r.ok).length
  const failed = results.filter((r) => !r.ok)
  return (
    <div className="space-y-2">
      <div className="rounded-md border border-success/40 bg-green-50 px-3 py-2 text-sm flex items-center gap-2">
        <CheckCircle2 className="h-4 w-4 text-success shrink-0" />
        <span>
          Applied {okCount} of {results.length} change
          {results.length === 1 ? "" : "s"}.
        </span>
      </div>
      {failed.length > 0 && (
        <div className="rounded-md border border-danger/40 bg-red-50">
          <div className="px-3 py-1.5 text-xs uppercase tracking-wide text-danger border-b border-danger/30 flex items-center gap-1.5">
            <XCircle className="h-3.5 w-3.5" />
            {failed.length} failure{failed.length === 1 ? "" : "s"}
          </div>
          <ul className="divide-y divide-danger/20 text-sm">
            {failed.map((r, i) => (
              <li key={i} className="px-3 py-2">
                <MutationRow mutation={r.mutation} />
                <div className="mt-1 text-xs text-danger font-mono">
                  {r.error}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

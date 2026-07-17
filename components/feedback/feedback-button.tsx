"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { toastActionError } from "@/lib/action-error"
import { MessageSquarePlus } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogFooter,
} from "@/components/ui/dialog"
import { Field, Input, Select, Textarea } from "@/components/ui/input"
import { submitFeedback } from "@/app/actions/feedback"
import { FEEDBACK_TYPES, type FeedbackType } from "@/lib/feedback"

// "Request an update" — lives in the top nav so any signed-in user can fire off
// a request from anywhere in the app. `dark` restyles the trigger for the
// dark top bar.
export function FeedbackButton({ dark = false }: { dark?: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={
          dark
            ? "inline-flex h-9 items-center gap-1.5 rounded-md px-2.5 text-sm text-white/70 hover:bg-white/10 hover:text-white cursor-pointer"
            : "inline-flex h-9 items-center gap-1.5 rounded-md px-2.5 text-sm text-muted hover:bg-background hover:text-foreground cursor-pointer"
        }
        title="Request an update"
      >
        <MessageSquarePlus className="h-4 w-4" />
        <span className="hidden xl:inline">Request an update</span>
      </button>
      {open && <FeedbackDialog onClose={() => setOpen(false)} />}
    </>
  )
}

function FeedbackDialog({ onClose }: { onClose: () => void }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [requestType, setRequestType] = useState<FeedbackType>("Feature Request")
  const [title, setTitle] = useState("")
  const [description, setDescription] = useState("")
  const [titleError, setTitleError] = useState<string | null>(null)

  function handleSubmit() {
    if (!title.trim()) {
      setTitleError("Title is required")
      return
    }
    setTitleError(null)
    startTransition(async () => {
      try {
        await submitFeedback({
          request_type: requestType,
          title: title.trim(),
          description: description.trim() || null,
        })
        toast.success("Request submitted — thank you!")
        onClose()
        router.refresh()
      } catch (e) {
        toastActionError(e, "Could not submit request")
      }
    })
  }

  return (
    <Dialog open={true} onOpenChange={(v) => !v && onClose()}>
      <DialogContent size="md">
        <DialogHeader>
          <div>
            <DialogTitle>Request an update</DialogTitle>
            <DialogDescription>
              Send a feature idea, bug report, or change request to the team.
            </DialogDescription>
          </div>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-4">
          <Field label="Type" htmlFor="fb-type">
            <Select
              id="fb-type"
              value={requestType}
              onChange={(e) => setRequestType(e.target.value as FeedbackType)}
            >
              {FEEDBACK_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Title" htmlFor="fb-title" error={titleError}>
            <Input
              id="fb-title"
              value={title}
              invalid={!!titleError}
              placeholder="Short summary of your request"
              maxLength={200}
              onChange={(e) => {
                setTitle(e.target.value)
                if (titleError) setTitleError(null)
              }}
            />
          </Field>
          <Field
            label="Description"
            htmlFor="fb-desc"
            hint="Optional — add any detail that helps us understand the request."
          >
            <Textarea
              id="fb-desc"
              value={description}
              rows={4}
              maxLength={5000}
              placeholder="What would you like changed or added?"
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={pending}>
            {pending ? "Submitting…" : "Submit request"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

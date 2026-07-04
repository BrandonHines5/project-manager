"use client"

import { useRef, useState } from "react"
import { Button } from "@/components/ui/button"

const ACCEPT = ".pdf,image/*"
const MAX_BYTES = 15 * 1024 * 1024

/**
 * The public upload widget. POSTs multipart form data to
 * /api/insurance-upload (a route handler, not a server action, so multi-MB
 * PDFs aren't subject to the server-action body limit). One file per
 * submit; subs with multiple certs can submit again.
 */
export function UploadForm({ token }: { token: string }) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [state, setState] = useState<
    | { phase: "idle" }
    | { phase: "uploading" }
    | { phase: "done" }
    | { phase: "error"; message: string }
  >({ phase: "idle" })

  async function submit() {
    if (!file) return
    if (file.size > MAX_BYTES) {
      setState({ phase: "error", message: "File is too large (15 MB max)." })
      return
    }
    setState({ phase: "uploading" })
    try {
      const body = new FormData()
      body.set("token", token)
      body.set("file", file)
      const res = await fetch("/api/insurance-upload", { method: "POST", body })
      const json = (await res.json().catch(() => null)) as
        | { ok: boolean; error?: string }
        | null
      if (!res.ok || !json?.ok) {
        setState({
          phase: "error",
          message: json?.error ?? "Upload failed. Please try again.",
        })
        return
      }
      setState({ phase: "done" })
    } catch {
      setState({
        phase: "error",
        message: "Upload failed. Check your connection and try again.",
      })
    }
  }

  if (state.phase === "done") {
    return (
      <div className="rounded-lg border border-border bg-background p-4 text-sm">
        <p className="font-medium text-foreground">Certificate received — thank you!</p>
        <p className="mt-1 text-muted-foreground">
          We&rsquo;ll review it and reach out if anything else is needed.
        </p>
        <Button
          variant="link"
          size="sm"
          className="mt-2 px-0"
          onClick={() => {
            // Clear the native input too, or re-picking the same file
            // won't fire onChange.
            if (inputRef.current) inputRef.current.value = ""
            setFile(null)
            setState({ phase: "idle" })
          }}
        >
          Upload another file
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        className="hidden"
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        className="w-full rounded-lg border-2 border-dashed border-border-strong bg-background p-6 text-center text-sm text-muted-foreground hover:border-brand-500 hover:text-foreground transition-colors cursor-pointer"
      >
        {file ? (
          <span className="font-medium text-foreground">{file.name}</span>
        ) : (
          <>Tap to choose a PDF or photo of your certificate</>
        )}
      </button>
      {state.phase === "error" && (
        <p className="text-sm text-danger">{state.message}</p>
      )}
      <Button
        className="w-full"
        disabled={!file || state.phase === "uploading"}
        onClick={submit}
      >
        {state.phase === "uploading" ? "Uploading…" : "Send certificate"}
      </Button>
    </div>
  )
}

"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Input, Label } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { acceptClientInvite } from "@/app/actions/invite-public"

export function AcceptInviteForm({
  token,
  disclaimer,
}: {
  token: string
  disclaimer: string
}) {
  const router = useRouter()
  const [password, setPassword] = useState("")
  const [confirm, setConfirm] = useState("")
  const [agreed, setAgreed] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (password.length < 8) {
      setError("Use at least 8 characters for your password.")
      return
    }
    if (password !== confirm) {
      setError("Those passwords don't match.")
      return
    }
    if (!agreed) {
      setError("Please accept the disclaimer to continue.")
      return
    }
    startTransition(async () => {
      const r = await acceptClientInvite({
        token,
        password,
        disclaimer_accepted: agreed,
      })
      if (r.ok) {
        toast.success("Account created — please sign in.")
        router.push("/login")
      } else {
        setError(r.error)
      }
    })
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <div>
        <Label className="mb-1">Create a password</Label>
        <Input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
          placeholder="At least 8 characters"
        />
      </div>
      <div>
        <Label className="mb-1">Confirm password</Label>
        <Input
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          autoComplete="new-password"
        />
      </div>
      <label className="flex items-start gap-2 text-sm cursor-pointer rounded-md border border-border bg-background p-3">
        <input
          type="checkbox"
          checked={agreed}
          onChange={(e) => setAgreed(e.target.checked)}
          className="h-4 w-4 mt-0.5 shrink-0"
        />
        <span className="text-muted">{disclaimer}</span>
      </label>
      {error && <p className="text-sm text-danger">{error}</p>}
      <Button type="submit" disabled={pending} className="h-11">
        {pending ? "Creating account…" : "Create account"}
      </Button>
    </form>
  )
}

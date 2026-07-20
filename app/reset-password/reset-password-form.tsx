"use client"

import { useEffect, useState } from "react"
import { createSupabaseBrowserClient } from "@/lib/supabase/client"
import { Card, CardBody, CardFooter } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Field, Input } from "@/components/ui/input"
import { toast } from "sonner"

/**
 * Set-a-new-password form. Reached via the "forgot password" email →
 * /auth/recovery (which exchanges the recovery code for a short-lived session)
 * → here. Confirms that recovery session exists, updates the password, then
 * signs back out and returns to /login — so the recovery flow never lands
 * anyone IN the app (the login form's SSO rules still govern who gets in).
 */
export function ResetPasswordForm() {
  const [ready, setReady] = useState(false)
  const [password, setPassword] = useState("")
  const [confirm, setConfirm] = useState("")
  const [submitting, setSubmitting] = useState(false)

  // A valid recovery session must be present (set by /auth/recovery). If not,
  // the link was invalid/expired — bounce back to login.
  useEffect(() => {
    const supabase = createSupabaseBrowserClient()
    supabase.auth.getUser().then(({ data }) => {
      if (!data.user) {
        window.location.assign("/login?error=reset")
        return
      }
      setReady(true)
    })
  }, [])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (password !== confirm) {
      toast.error("Those passwords don't match.")
      return
    }
    if (password.length < 8) {
      toast.error("Use at least 8 characters.")
      return
    }
    setSubmitting(true)
    const supabase = createSupabaseBrowserClient()
    try {
      const { error } = await supabase.auth.updateUser({ password })
      if (error) throw error
      // Don't leave them signed in on the recovery session — send them through
      // the normal login so the SSO rules apply.
      await supabase.auth.signOut()
      window.location.assign("/login?reset=1")
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Couldn't update your password."
      )
      setSubmitting(false)
    }
  }

  return (
    <Card>
      <form onSubmit={submit}>
        <CardBody className="space-y-4">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">
              Set a new password
            </h2>
            <p className="mt-1 text-sm text-muted">
              Choose a new password for your account.
            </p>
          </div>
          <Field label="New password">
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="new-password"
              minLength={8}
              disabled={!ready}
            />
          </Field>
          <Field label="Confirm new password">
            <Input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
              autoComplete="new-password"
              minLength={8}
              disabled={!ready}
            />
          </Field>
        </CardBody>
        <CardFooter>
          <Button type="submit" disabled={submitting || !ready} className="w-full">
            {submitting ? "Updating…" : "Update password"}
          </Button>
        </CardFooter>
      </form>
    </Card>
  )
}

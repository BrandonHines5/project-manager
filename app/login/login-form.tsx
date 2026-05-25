"use client"

import { useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { createSupabaseBrowserClient } from "@/lib/supabase/client"
import { Card, CardBody, CardFooter } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Field, Input } from "@/components/ui/input"
import { toast } from "sonner"

export function LoginForm() {
  const router = useRouter()
  const params = useSearchParams()
  const redirectTo = params.get("redirect") ?? "/projects"

  const [mode, setMode] = useState<"signin" | "signup">("signin")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [fullName, setFullName] = useState("")
  const [submitting, setSubmitting] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    const supabase = createSupabaseBrowserClient()
    try {
      if (mode === "signup") {
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            data: { full_name: fullName, role: "staff" },
            emailRedirectTo: window.location.origin + redirectTo,
          },
        })
        if (error) throw error
        toast.success("Account created. Check your email if confirmation is enabled.")
      } else {
        const { error } = await supabase.auth.signInWithPassword({
          email,
          password,
        })
        if (error) throw error
      }
      router.replace(redirectTo)
      router.refresh()
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Sign-in failed"
      toast.error(msg)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Card>
      <form onSubmit={submit}>
        <CardBody className="space-y-4">
          {mode === "signup" && (
            <Field label="Full name">
              <Input
                type="text"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                placeholder="Jane Builder"
                required
                autoComplete="name"
              />
            </Field>
          )}
          <Field label="Email">
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@hineshomes.com"
              required
              autoComplete="email"
            />
          </Field>
          <Field label="Password">
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete={mode === "signup" ? "new-password" : "current-password"}
              minLength={6}
            />
          </Field>
        </CardBody>
        <CardFooter className="flex flex-col gap-3">
          <Button type="submit" disabled={submitting} className="w-full">
            {submitting ? "…" : mode === "signin" ? "Sign in" : "Create account"}
          </Button>
          <button
            type="button"
            onClick={() => setMode(mode === "signin" ? "signup" : "signin")}
            className="text-xs text-muted hover:text-foreground cursor-pointer"
          >
            {mode === "signin"
              ? "Need an account? Create one"
              : "Have an account? Sign in"}
          </button>
        </CardFooter>
      </form>
    </Card>
  )
}

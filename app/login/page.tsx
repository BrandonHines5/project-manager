import { redirect } from "next/navigation"
import { Suspense } from "react"
import { LoginForm } from "./login-form"
import { getSessionProfile } from "@/lib/auth"

export const metadata = { title: "Sign in — Hines Homes" }
export const dynamic = "force-dynamic"

export default async function LoginPage() {
  // If the user is already signed in, send them to the app.
  // Done server-side here (not in middleware) to avoid the Supabase
  // middleware-redirect cookie sync bug.
  const profile = await getSessionProfile()
  if (profile) redirect("/projects")

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          <div className="inline-flex h-12 w-12 items-center justify-center rounded-lg bg-brand-500 text-white text-xl font-bold shadow-sm">
            HH
          </div>
          <h1 className="mt-4 text-2xl font-semibold text-foreground">
            Hines Homes — Project Manager
          </h1>
          <p className="mt-1 text-sm text-muted">Sign in to continue</p>
        </div>
        <Suspense fallback={null}>
          <LoginForm />
        </Suspense>
      </div>
    </div>
  )
}

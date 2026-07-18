import { redirect } from "next/navigation"
import { Suspense } from "react"
import { LoginForm } from "./login-form"
import { getSessionProfile } from "@/lib/auth"

export const metadata = { title: "Sign in — BuildFox" }
export const dynamic = "force-dynamic"

export default async function LoginPage() {
  // If the user is already signed in, send them to the app.
  // Done server-side here (not in middleware) to avoid the Supabase
  // middleware-redirect cookie sync bug.
  const profile = await getSessionProfile()
  if (profile) redirect("/projects")

  return (
    <div className="min-h-dvh flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          {/* Product mark — BuildFox is the app; the builder's own brand
              (lib/brand.ts) stays on client/sub-facing surfaces. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/brand/buildfox-mark.svg"
            alt="BuildFox"
            className="mx-auto h-12 w-12 rounded-lg shadow-sm"
          />
          <h1 className="mt-4 text-2xl font-semibold text-foreground">BuildFox</h1>
          <p className="mt-1 text-sm text-muted">
            Sign in to Hines Homes project management
          </p>
        </div>
        <Suspense fallback={null}>
          <LoginForm />
        </Suspense>
      </div>
    </div>
  )
}

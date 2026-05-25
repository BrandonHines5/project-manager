import { NextResponse, type NextRequest } from "next/server"
import { createServerClient } from "@supabase/ssr"
import type { Database } from "@/lib/db/types"

// Middleware here ONLY refreshes the Supabase auth tokens. It never redirects.
// Redirecting from middleware is what causes the classic "browser ↔ server
// out of sync, infinite /login ↔ /projects loop" — see the Supabase SSR docs
// warning. Page-level `requireSession()` / login client logic handle redirects.
export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request })

  const supabase = createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          )
          response = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  const { data: { user }, error } = await supabase.auth.getUser()
  console.log("[proxy]", request.nextUrl.pathname, {
    hasUser: !!user,
    userId: user?.id,
    error: error?.message,
    cookieNames: request.cookies.getAll().map((c) => c.name),
  })

  return response
}

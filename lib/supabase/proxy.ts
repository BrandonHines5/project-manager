import { NextResponse, type NextRequest } from "next/server"
import { createServerClient } from "@supabase/ssr"
import type { Database } from "@/lib/db/types"

const PUBLIC_PATHS = ["/login", "/auth"]

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

  const {
    data: { user },
  } = await supabase.auth.getUser()

  const path = request.nextUrl.pathname
  const isPublic =
    PUBLIC_PATHS.some((p) => path === p || path.startsWith(`${p}/`)) ||
    path.startsWith("/_next") ||
    path === "/favicon.ico"

  // Build a redirect response that carries forward any cookies Supabase set
  // on the working response during getUser() (e.g. refreshed auth tokens).
  // Without this, the redirect strips the new cookies and the next request
  // looks unauthenticated → endless /login ↔ /projects loop.
  const redirectKeepingCookies = (url: URL) => {
    const r = NextResponse.redirect(url)
    for (const c of response.cookies.getAll()) {
      r.cookies.set(c)
    }
    r.headers.set("cache-control", "no-store")
    return r
  }

  if (!user && !isPublic) {
    const url = request.nextUrl.clone()
    url.pathname = "/login"
    url.searchParams.set("redirect", path)
    return redirectKeepingCookies(url)
  }

  if (user && (path === "/login" || path === "/")) {
    const url = request.nextUrl.clone()
    url.pathname = "/projects"
    url.search = ""
    return redirectKeepingCookies(url)
  }

  // Never let the CDN cache an auth-affected response on protected paths.
  if (!isPublic) {
    response.headers.set("cache-control", "no-store")
  }
  return response
}

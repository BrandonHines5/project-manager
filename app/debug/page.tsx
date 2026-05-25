import { cookies, headers } from "next/headers"
import { createSupabaseServerClient } from "@/lib/supabase/server"

export const dynamic = "force-dynamic"
export const metadata = { title: "Debug — auth state" }

export default async function DebugPage() {
  const cookieStore = await cookies()
  const headerList = await headers()
  const allCookies = cookieStore.getAll()
  const supabase = await createSupabaseServerClient()
  const { data: { user }, error } = await supabase.auth.getUser()

  let profile = null
  let profileErr: string | null = null
  if (user) {
    const r = await supabase.from("profiles").select("*").eq("id", user.id).maybeSingle()
    profile = r.data
    profileErr = r.error?.message ?? null
  }

  return (
    <div style={{ fontFamily: "monospace", padding: 20, fontSize: 13 }}>
      <h1>Auth diagnostic</h1>

      <h2>Cookies the server sees ({allCookies.length})</h2>
      <table border={1} cellPadding={6} style={{ borderCollapse: "collapse" }}>
        <thead><tr><th>name</th><th>value preview (first 40 chars)</th></tr></thead>
        <tbody>
          {allCookies.map((c) => (
            <tr key={c.name}>
              <td>{c.name}</td>
              <td>{(c.value || "").slice(0, 40)}{c.value && c.value.length > 40 ? "…" : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>supabase.auth.getUser()</h2>
      <pre>
{JSON.stringify({
  user: user ? { id: user.id, email: user.email, role: user.role } : null,
  error: error?.message ?? null,
}, null, 2)}
      </pre>

      <h2>profile lookup</h2>
      <pre>
{JSON.stringify({
  profile: profile ? { id: profile.id, email: profile.email, role: profile.role, full_name: profile.full_name } : null,
  error: profileErr,
}, null, 2)}
      </pre>

      <h2>env vars on server</h2>
      <pre>
{JSON.stringify({
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY_present:
    !!process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY_first_20:
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.slice(0, 20),
}, null, 2)}
      </pre>

      <h2>request headers</h2>
      <pre>
{JSON.stringify({
  host: headerList.get("host"),
  origin: headerList.get("origin"),
  referer: headerList.get("referer"),
}, null, 2)}
      </pre>
    </div>
  )
}

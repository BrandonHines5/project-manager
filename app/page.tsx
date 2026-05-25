import { redirect } from "next/navigation"
import { getSessionProfile } from "@/lib/auth"

// This route reads cookies and issues an auth-dependent redirect.
// Without force-dynamic the CDN may cache one user's redirect for another.
export const dynamic = "force-dynamic"

export default async function Home() {
  const profile = await getSessionProfile()
  redirect(profile ? "/projects" : "/login")
}

import { redirect } from "next/navigation"
import { getSessionProfile } from "@/lib/auth"

export default async function Home() {
  const profile = await getSessionProfile()
  redirect(profile ? "/projects" : "/login")
}

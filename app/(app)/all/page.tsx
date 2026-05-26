import { redirect } from "next/navigation"

// Bare /all has no content of its own — send the user to the schedule view
// which is the most-likely landing spot from the sidebar footer.
export default function AllIndexPage() {
  redirect("/all/schedule")
}

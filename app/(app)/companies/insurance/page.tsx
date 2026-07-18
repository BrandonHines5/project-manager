import { redirect } from "next/navigation"

// The Insurance page became Vendor Documents (it stores W9s and master
// agreements alongside certificates) — keep old links and bookmarks working.
export default function LegacyInsuranceRedirect() {
  redirect("/companies/vendor-documents")
}

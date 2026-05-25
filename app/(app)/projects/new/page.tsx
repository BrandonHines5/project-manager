import { requireStaff } from "@/lib/auth"
import { NewProjectForm } from "./new-project-form"

export const metadata = { title: "New project — Hines Homes" }

export default async function NewProjectPage() {
  await requireStaff()
  return (
    <div className="max-w-2xl mx-auto px-4 md:px-6 py-6">
      <h1 className="text-2xl font-semibold tracking-tight mb-1">New project</h1>
      <p className="text-sm text-muted mb-6">
        Create a project. The project number should match your dashboard site.
      </p>
      <NewProjectForm />
    </div>
  )
}

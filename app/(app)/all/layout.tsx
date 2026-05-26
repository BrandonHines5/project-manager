import { AllTabs } from "./all-tabs"

export default function AllLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div className="max-w-7xl mx-auto px-4 md:px-6 py-6">
      <div className="mb-4">
        <div className="text-xs uppercase tracking-wider text-muted mb-1">
          Across selected projects
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">Aggregate view</h1>
      </div>
      <AllTabs />
      {children}
    </div>
  )
}

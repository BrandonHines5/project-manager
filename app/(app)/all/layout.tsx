export default function AllLayout({
  children,
}: {
  children: React.ReactNode
}) {
  // Section switching lives in the SectionTabs bar under the topbar; this
  // layout only frames the page.
  return (
    <div className="max-w-7xl mx-auto px-4 md:px-6 py-6">
      <div className="mb-4">
        <h1 className="text-2xl font-semibold tracking-tight">All jobs</h1>
        <p className="text-sm text-muted">
          Every open job at once — check jobs in the list on the left to
          narrow the view.
        </p>
      </div>
      {children}
    </div>
  )
}

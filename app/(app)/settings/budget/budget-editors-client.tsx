"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  saveBudgetEditors,
  type BudgetEditorConfig,
} from "@/app/actions/budget"

export function BudgetEditorsClient({ config }: { config: BudgetEditorConfig }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [selected, setSelected] = useState<Set<string>>(
    new Set(config.selected)
  )

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function handleSave() {
    startTransition(async () => {
      try {
        await saveBudgetEditors([...selected])
        toast.success("Budget editors saved")
        router.refresh()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Save failed")
      }
    })
  }

  return (
    <div className="max-w-2xl mx-auto px-4 md:px-6 py-6 space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Budget editors</h1>
        <p className="mt-1 text-sm text-muted">
          Everyone with financial access can <em>view</em> a job&rsquo;s Budget
          tab. Only the people checked here can <em>change</em> it — budget
          amounts, forecast overrides, imports, and removing lines. Unchecking
          everyone makes budgets read-only for all.
        </p>
      </div>
      <section className="rounded-lg border border-border bg-surface p-5">
        {!config.explicit && (
          <p className="mb-3 text-xs text-muted">
            No editor list has been saved yet, so everyone with financial
            access can currently edit. The checkboxes below show that effective
            set — saving makes the list explicit.
          </p>
        )}
        <ul className="space-y-1.5">
          {config.staff.map((p) => (
            <li key={p.id}>
              <label className="inline-flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={selected.has(p.id)}
                  onChange={() => toggle(p.id)}
                  className="h-4 w-4 rounded border-border-strong accent-brand-500"
                />
                {p.full_name ?? "Unnamed"}
                {!p.financial_access && (
                  <span className="text-xs text-muted">
                    (no financial access — can&rsquo;t reach the Budget tab yet)
                  </span>
                )}
              </label>
            </li>
          ))}
        </ul>
        <div className="mt-4">
          <Button size="sm" onClick={handleSave} disabled={pending}>
            {pending ? "Saving…" : "Save editors"}
          </Button>
        </div>
      </section>
    </div>
  )
}

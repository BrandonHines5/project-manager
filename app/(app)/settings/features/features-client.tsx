"use client"

import { useMemo, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Lock, Plus, SlidersHorizontal, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { LEGACY_ORG_ID } from "@/lib/org"
import {
  FEATURE_DEFS,
  INTERNAL_PLAN,
  type FeatureKey,
} from "@/lib/features"
import {
  createPlatformPlan,
  savePlatformPlan,
  deletePlatformPlan,
  setOrganizationPlan,
} from "@/app/actions/platform"

export type PlanRow = { key: string; name: string; features: FeatureKey[] }
export type OrgRow = {
  id: string
  name: string
  slug: string
  status: string | null
  plan: string
}

/**
 * Feature-access editor (0122, platform operator only): a features × levels
 * checkbox matrix plus per-org level assignment. The Internal column is
 * display-only — it always includes everything, by code, so the operator's
 * own orgs can't be accidentally restricted.
 */
export function FeatureAccessClient({
  plans,
  orgs,
}: {
  plans: PlanRow[]
  orgs: OrgRow[]
}) {
  return (
    <div className="max-w-4xl mx-auto px-4 md:px-6 py-6 space-y-4">
      <div className="flex items-start gap-2">
        <SlidersHorizontal className="h-5 w-5 mt-0.5 text-muted" />
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Feature access</h1>
          <p className="text-sm text-muted">
            Define access levels, choose which features each level includes,
            and assign organizations to levels. New organizations start on
            Internal (everything on) until assigned.
          </p>
        </div>
      </div>
      <LevelsMatrix plans={plans} orgs={orgs} />
      <OrgAssignments plans={plans} orgs={orgs} />
    </div>
  )
}

/**
 * The features × levels checkbox matrix: rename levels inline, toggle their
 * features, save per level, add new levels, delete empty ones. Holds a local
 * edit buffer; a saved level re-seeds from fresh server props on refresh.
 */
function LevelsMatrix({ plans, orgs }: { plans: PlanRow[]; orgs: OrgRow[] }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [newName, setNewName] = useState("")
  // Local edit buffer keyed by plan; router.refresh() re-seeds via the
  // key={} remount below when a save lands.
  const [edits, setEdits] = useState<
    Record<string, { name: string; features: FeatureKey[] }>
  >(() =>
    Object.fromEntries(
      plans
        .filter((p) => p.key !== INTERNAL_PLAN)
        .map((p) => [p.key, { name: p.name, features: [...p.features] }])
    )
  )

  const orgCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const o of orgs) counts[o.plan] = (counts[o.plan] ?? 0) + 1
    return counts
  }, [orgs])

  const editable = plans.filter((p) => p.key !== INTERNAL_PLAN)
  const internal = plans.find((p) => p.key === INTERNAL_PLAN)

  const isDirty = (key: string) => {
    const base = plans.find((p) => p.key === key)
    const edit = edits[key]
    if (!base || !edit) return false
    return (
      base.name !== edit.name.trim() ||
      base.features.length !== edit.features.length ||
      base.features.some((f) => !edit.features.includes(f))
    )
  }

  const toggle = (key: string, feature: FeatureKey) => {
    setEdits((prev) => {
      const cur = prev[key]
      if (!cur) return prev
      const has = cur.features.includes(feature)
      return {
        ...prev,
        [key]: {
          ...cur,
          features: has
            ? cur.features.filter((f) => f !== feature)
            : [...cur.features, feature],
        },
      }
    })
  }

  const save = (key: string) => {
    const edit = edits[key]
    if (!edit) return
    startTransition(async () => {
      const result = await savePlatformPlan({
        key,
        name: edit.name.trim() || undefined,
        features: edit.features,
      })
      if (result.ok) {
        toast.success("Level saved")
        router.refresh()
      } else {
        toast.error(result.error ?? "Couldn't save the level.")
      }
    })
  }

  const remove = (key: string) => {
    startTransition(async () => {
      const result = await deletePlatformPlan({ key })
      if (result.ok) {
        toast.success("Level deleted")
        setEdits((prev) => {
          const next = { ...prev }
          delete next[key]
          return next
        })
        router.refresh()
      } else {
        toast.error(result.error ?? "Couldn't delete the level.")
      }
    })
  }

  const add = () => {
    const name = newName.trim()
    if (!name) return
    startTransition(async () => {
      const result = await createPlatformPlan({ name })
      if (result.ok) {
        toast.success(`Level "${name}" created — now pick its features`)
        setNewName("")
        setEdits((prev) => ({ ...prev, [result.key]: { name, features: [] } }))
        router.refresh()
      } else {
        toast.error(result.error ?? "Couldn't create the level.")
      }
    })
  }

  return (
    <section className="rounded-lg border border-border bg-surface p-5 space-y-4">
      <div>
        <div className="text-sm font-medium">Access levels</div>
        <div className="text-xs text-muted">
          Check the features each level includes, then Save that level.
          Internal always has everything.
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left border-b border-border">
              <th className="py-2 pr-4 font-medium min-w-[220px]">Feature</th>
              {internal && (
                <th className="py-2 px-3 font-medium text-center min-w-[110px]">
                  <span className="inline-flex items-center gap-1">
                    <Lock className="h-3 w-3 text-muted" />
                    {internal.name}
                  </span>
                </th>
              )}
              {editable.map((p) => (
                <th key={p.key} className="py-2 px-3 text-center min-w-[150px]">
                  <Input
                    value={edits[p.key]?.name ?? p.name}
                    onChange={(e) =>
                      setEdits((prev) => ({
                        ...prev,
                        [p.key]: {
                          features: prev[p.key]?.features ?? [...p.features],
                          name: e.target.value,
                        },
                      }))
                    }
                    maxLength={80}
                    className="h-8 text-center font-medium"
                    aria-label={`Level name for ${p.key}`}
                  />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {FEATURE_DEFS.map((f) => (
              <tr key={f.key} className="border-b border-border/60 align-top">
                <td className="py-2.5 pr-4">
                  <div className="font-medium">{f.label}</div>
                  <div className="text-xs text-muted">{f.description}</div>
                </td>
                {internal && (
                  <td className="py-2.5 px-3 text-center text-brand-600">✓</td>
                )}
                {editable.map((p) => (
                  <td key={p.key} className="py-2.5 px-3 text-center">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-[var(--color-brand-500)] cursor-pointer"
                      checked={edits[p.key]?.features.includes(f.key) ?? false}
                      onChange={() => toggle(p.key, f.key)}
                      aria-label={`${f.label} in ${edits[p.key]?.name ?? p.key}`}
                    />
                  </td>
                ))}
              </tr>
            ))}
            <tr>
              <td className="py-2.5 pr-4 text-xs text-muted">
                Organizations on level
              </td>
              {internal && (
                <td className="py-2.5 px-3 text-center text-xs text-muted">
                  {orgCounts[INTERNAL_PLAN] ?? 0}
                </td>
              )}
              {editable.map((p) => (
                <td key={p.key} className="py-2.5 px-3 text-center">
                  <div className="flex flex-col items-center gap-1.5">
                    <span className="text-xs text-muted">
                      {orgCounts[p.key] ?? 0}
                    </span>
                    <Button
                      size="sm"
                      onClick={() => save(p.key)}
                      disabled={pending || !isDirty(p.key)}
                    >
                      Save
                    </Button>
                    {(orgCounts[p.key] ?? 0) === 0 && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => remove(p.key)}
                        disabled={pending}
                        aria-label={`Delete level ${p.name}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>

      <div className="flex items-center gap-2 pt-1">
        <Input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="New level name (e.g. Essentials, Pro)"
          maxLength={80}
          className="max-w-[280px]"
          onKeyDown={(e) => {
            if (e.key === "Enter") add()
          }}
        />
        <Button size="sm" onClick={add} disabled={pending || !newName.trim()}>
          <Plus className="h-4 w-4 mr-1" />
          Add level
        </Button>
      </div>
    </section>
  )
}

/**
 * The organization → level assignment table. The legacy (platform) org is
 * rendered locked to Internal; the server refuses moving it regardless.
 */
function OrgAssignments({ plans, orgs }: { plans: PlanRow[]; orgs: OrgRow[] }) {
  const router = useRouter()
  const [pendingOrg, setPendingOrg] = useState<string | null>(null)

  const assign = async (orgId: string, plan: string) => {
    setPendingOrg(orgId)
    const result = await setOrganizationPlan({ orgId, plan })
    setPendingOrg(null)
    if (result.ok) {
      toast.success("Level updated")
      router.refresh()
    } else {
      toast.error(result.error ?? "Couldn't update the level.")
    }
  }

  return (
    <section className="rounded-lg border border-border bg-surface p-5 space-y-4">
      <div>
        <div className="text-sm font-medium">Organizations</div>
        <div className="text-xs text-muted">
          Which level each organization is on. Changes apply on their next
          page load.
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left border-b border-border">
              <th className="py-2 pr-4 font-medium">Organization</th>
              <th className="py-2 pr-4 font-medium">Status</th>
              <th className="py-2 pr-4 font-medium">Level</th>
            </tr>
          </thead>
          <tbody>
            {orgs.map((o) => {
              const legacy = o.id === LEGACY_ORG_ID
              return (
                <tr key={o.id} className="border-b border-border/60">
                  <td className="py-2.5 pr-4">
                    <div className="font-medium">{o.name}</div>
                    <div className="text-xs text-muted">{o.slug}</div>
                  </td>
                  <td className="py-2.5 pr-4 text-xs text-muted">
                    {legacy ? "Platform" : o.status ?? "—"}
                  </td>
                  <td className="py-2.5 pr-4">
                    {legacy ? (
                      <span className="inline-flex items-center gap-1 text-xs text-muted">
                        <Lock className="h-3 w-3" />
                        Internal
                      </span>
                    ) : (
                      <select
                        value={o.plan}
                        onChange={(e) => assign(o.id, e.target.value)}
                        disabled={pendingOrg === o.id}
                        className="h-8 rounded-md border border-border bg-surface px-2 text-sm disabled:opacity-50"
                        aria-label={`Access level for ${o.name}`}
                      >
                        {plans.map((p) => (
                          <option key={p.key} value={p.key}>
                            {p.name}
                          </option>
                        ))}
                      </select>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
}

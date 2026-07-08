"use client"

import { useEffect, useRef, useState } from "react"
import {
  getTemplateProfile,
  type TemplateProfile,
  type SelectionOverrideT,
} from "@/app/actions/projects"
import { getTemplateTagConfig } from "@/app/actions/settings"
import { Input, Label } from "@/components/ui/input"
import { formatCurrency } from "@/lib/utils"
import {
  attributesWithGroupSelections,
  matchesTemplateTags,
  tagLabel,
  type TemplateAttributes,
  type TemplateTagGroup,
} from "@/lib/template-tags"

export type TemplateOptionsValue =
  | {
      status: "ready"
      attributes: TemplateAttributes
      selection_overrides: SelectionOverrideT[]
      // False while a required either/or group is unanswered — parents keep
      // their submit button disabled until this is true.
      valid: boolean
      // Labels of required groups still awaiting a pick, for the parent hint.
      missingRequired: string[]
    }
  // Profile fetch failed — parents may proceed without answers (the server
  // then copies everything, the pre-smart-template behavior).
  | { status: "error" }

/**
 * Smart-template steps shown wherever a template is being duplicated:
 *
 * 1. Build options — required either/or groups defined in Settings → Template
 *    tags (Single vs Multi Level, Spec vs Custom); each renders as a single
 *    select that must be answered before the project can be created.
 * 2. House attributes — one yes/no checkbox per remaining (ungrouped) template
 *    tag ("Walkout basement?"). Tagging a new template item adds its question.
 * 3. Selections & allowances — review the selections that survive the answers.
 *
 * Reports the combined answers upward via onChange (null while loading); the
 * parent passes them to duplicateProject / serializes them into the
 * create-project form and gates its submit button on `valid`.
 */
export function TemplateOptionsFields({
  sourceProjectId,
  onChange,
}: {
  sourceProjectId: string
  onChange: (value: TemplateOptionsValue | null) => void
}) {
  // Keyed remount: switching templates resets all answer state without
  // synchronous setState-in-effect resets (react-hooks/set-state-in-effect).
  return (
    <TemplateOptionsInner
      key={sourceProjectId}
      sourceProjectId={sourceProjectId}
      onChange={onChange}
    />
  )
}

function TemplateOptionsInner({
  sourceProjectId,
  onChange,
}: {
  sourceProjectId: string
  onChange: (value: TemplateOptionsValue | null) => void
}) {
  const [profile, setProfile] = useState<TemplateProfile | null>(null)
  const [groups, setGroups] = useState<TemplateTagGroup[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  // Ungrouped yes/no answers keyed by base tag.
  const [attrs, setAttrs] = useState<TemplateAttributes>({})
  // Either/or group answers keyed by group id → chosen option tag.
  const [groupSel, setGroupSel] = useState<Record<string, string>>({})
  const [included, setIncluded] = useState<Record<string, boolean>>({})
  const [allowanceText, setAllowanceText] = useState<Record<string, string>>({})

  // Keep the latest onChange without making it an effect dependency — an
  // inline lambda from the parent would otherwise re-fire the effect every
  // render and loop.
  const onChangeRef = useRef(onChange)
  useEffect(() => {
    onChangeRef.current = onChange
  })

  useEffect(() => {
    let cancelled = false
    Promise.all([
      getTemplateProfile({ source_project_id: sourceProjectId }),
      getTemplateTagConfig(),
    ])
      .then(([p, cfg]) => {
        if (cancelled) return
        const allow: Record<string, string> = {}
        for (const s of p.selections) {
          allow[s.id] = s.allowance_amount != null ? String(s.allowance_amount) : ""
        }
        setAllowanceText(allow)
        setGroups(cfg.groups)
        setProfile(p)
      })
      .catch((e) => {
        if (cancelled) return
        setLoadError(
          e instanceof Error ? e.message : "Couldn't load template options"
        )
      })
    return () => {
      cancelled = true
    }
  }, [sourceProjectId])

  // A group is shown when it's required (always enforced) or the template
  // actually carries one of its option tags. All its options render either way.
  const templateTags = profile?.tags ?? []
  const shownGroups = groups.filter(
    (g) => g.required || g.options.some((o) => templateTags.includes(o))
  )
  const groupedTagSet = new Set(groups.flatMap((g) => g.options))
  const ungroupedTags = templateTags.filter((t) => !groupedTagSet.has(t))
  const effectiveAttrs = attributesWithGroupSelections(attrs, shownGroups, groupSel)
  const missingRequired = shownGroups
    .filter((g) => g.required && !groupSel[g.id])
    .map((g) => g.label)

  const visibleSelections =
    profile?.selections.filter((s) =>
      matchesTemplateTags(s.template_tags, effectiveAttrs)
    ) ?? []
  const hiddenByTags = (profile?.selections.length ?? 0) - visibleSelections.length

  // Push the combined answers upward whenever anything changes (null while the
  // profile loads so the parent never submits a previous template's answers).
  // Recomputed inline from raw state to keep the dep list honest.
  useEffect(() => {
    if (loadError) {
      onChangeRef.current({ status: "error" })
      return
    }
    if (!profile) {
      onChangeRef.current(null)
      return
    }
    const shown = groups.filter(
      (g) => g.required || g.options.some((o) => profile.tags.includes(o))
    )
    const eff = attributesWithGroupSelections(attrs, shown, groupSel)
    const missing = shown
      .filter((g) => g.required && !groupSel[g.id])
      .map((g) => g.label)
    onChangeRef.current({
      status: "ready",
      attributes: eff,
      valid: missing.length === 0,
      missingRequired: missing,
      selection_overrides: profile.selections
        .filter((s) => matchesTemplateTags(s.template_tags, eff))
        .map((s) => {
          const raw = (allowanceText[s.id] ?? "").trim()
          const num = raw === "" ? null : Number(raw)
          return {
            decision_id: s.id,
            include: included[s.id] !== false,
            allowance_amount: num != null && !isNaN(num) ? num : null,
          }
        }),
    })
  }, [profile, loadError, groups, attrs, groupSel, included, allowanceText])

  if (loadError) {
    return (
      <p className="text-sm text-danger">
        {loadError} — continuing will copy ALL template items without
        house-attribute filtering.
      </p>
    )
  }
  if (!profile) {
    return <p className="text-sm text-muted">Loading template options…</p>
  }
  if (
    shownGroups.length === 0 &&
    ungroupedTags.length === 0 &&
    profile.selections.length === 0
  ) {
    return null
  }

  return (
    <div className="space-y-4">
      {shownGroups.length > 0 && (
        <div>
          <Label>Build options</Label>
          <p className="text-xs text-muted mb-2">
            Pick one per row. Rows marked{" "}
            <span className="text-danger">*</span> are required — the project
            can&apos;t be created until they&apos;re answered.
          </p>
          <div className="space-y-2.5">
            {shownGroups.map((g) => (
              <div key={g.id}>
                <div className="text-sm font-medium mb-1">
                  {g.label}
                  {g.required && <span className="text-danger"> *</span>}
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                  {g.options.map((opt) => (
                    <label
                      key={opt}
                      className="flex items-center gap-2 text-sm cursor-pointer"
                    >
                      <input
                        type="radio"
                        name={`grp-${g.id}`}
                        className="h-4 w-4 accent-brand-500"
                        checked={groupSel[g.id] === opt}
                        onChange={() =>
                          setGroupSel((cur) => ({ ...cur, [g.id]: opt }))
                        }
                      />
                      {tagLabel(opt)}
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
          {missingRequired.length > 0 && (
            <p className="mt-2 text-xs text-amber-700">
              Pick an option for: {missingRequired.join(", ")}.
            </p>
          )}
        </div>
      )}
      {ungroupedTags.length > 0 && (
        <div>
          <Label>House attributes</Label>
          <p className="text-xs text-muted mb-2">
            Check what applies to this build — template items conditioned on
            these (waterproofing for a walkout, etc.) are only copied when
            they match.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1.5">
            {ungroupedTags.map((tag) => (
              <label
                key={tag}
                className="flex items-center gap-2 text-sm cursor-pointer"
              >
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-brand-500"
                  checked={attrs[tag] === true}
                  onChange={(e) =>
                    setAttrs((cur) => ({ ...cur, [tag]: e.target.checked }))
                  }
                />
                {tagLabel(tag)}
              </label>
            ))}
          </div>
        </div>
      )}
      {profile.selections.length > 0 && (
        <div>
          <Label>Selections &amp; allowances</Label>
          <p className="text-xs text-muted mb-2">
            Uncheck selections that aren&apos;t in this contract, and enter
            each allowance from the contract&apos;s allowance schedule
            (leave blank for no allowance).
          </p>
          <ul className="space-y-1.5">
            {visibleSelections.map((s) => {
              const isIncluded = included[s.id] !== false
              return (
                <li key={s.id} className="flex items-center gap-2">
                  <label className="flex items-center gap-2 text-sm flex-1 min-w-0 cursor-pointer">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-brand-500 shrink-0"
                      checked={isIncluded}
                      onChange={(e) =>
                        setIncluded((cur) => ({
                          ...cur,
                          [s.id]: e.target.checked,
                        }))
                      }
                    />
                    <span className="truncate">{s.title}</span>
                  </label>
                  <div className="relative w-32 shrink-0">
                    <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-muted">
                      $
                    </span>
                    <Input
                      type="number"
                      step="0.01"
                      min="0"
                      placeholder="Allowance"
                      disabled={!isIncluded}
                      value={allowanceText[s.id] ?? ""}
                      onChange={(e) =>
                        setAllowanceText((cur) => ({
                          ...cur,
                          [s.id]: e.target.value,
                        }))
                      }
                      className="pl-6 text-right tabular-nums"
                    />
                  </div>
                </li>
              )
            })}
          </ul>
          {hiddenByTags > 0 && (
            <p className="text-xs text-muted mt-1.5">
              {hiddenByTags} selection{hiddenByTags === 1 ? "" : "s"} excluded
              by the answers above.
            </p>
          )}
          <p className="text-xs text-muted mt-1.5">
            Allowance total:{" "}
            {formatCurrency(
              visibleSelections.reduce((sum, s) => {
                if (included[s.id] === false) return sum
                const n = Number((allowanceText[s.id] ?? "").trim())
                return sum + (isNaN(n) ? 0 : n)
              }, 0)
            )}
          </p>
        </div>
      )}
    </div>
  )
}

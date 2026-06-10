"use client"

import { useEffect, useRef, useState } from "react"
import {
  getTemplateProfile,
  type TemplateProfile,
  type SelectionOverrideT,
} from "@/app/actions/projects"
import { Input, Label } from "@/components/ui/input"
import { formatCurrency } from "@/lib/utils"
import {
  matchesTemplateTags,
  tagLabel,
  type TemplateAttributes,
} from "@/lib/template-tags"

export type TemplateOptionsValue =
  | {
      status: "ready"
      attributes: TemplateAttributes
      selection_overrides: SelectionOverrideT[]
    }
  // Profile fetch failed — parents may proceed without answers (the server
  // then copies everything, the pre-smart-template behavior).
  | { status: "error" }

/**
 * Smart-template steps shown wherever a template is being duplicated:
 *
 * 1. House attributes — one yes/no checkbox per distinct template tag found
 *    on the template's schedule items + decisions ("Walkout basement?").
 *    Tagging a new template item automatically adds its question here.
 * 2. Selections & allowances — review the selections that survive the
 *    answers: drop ones that aren't in this contract and type in each
 *    allowance from the contract's allowance schedule.
 *
 * Reports the combined answers upward via onChange (null while loading);
 * the parent passes them to duplicateProject / serializes them into the
 * create-project form.
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
  const [loadError, setLoadError] = useState<string | null>(null)
  const [attrs, setAttrs] = useState<TemplateAttributes>({})
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
    getTemplateProfile({ source_project_id: sourceProjectId })
      .then((p) => {
        if (cancelled) return
        const allow: Record<string, string> = {}
        for (const s of p.selections) {
          allow[s.id] = s.allowance_amount != null ? String(s.allowance_amount) : ""
        }
        setAllowanceText(allow)
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

  const visibleSelections =
    profile?.selections.filter((s) => matchesTemplateTags(s.template_tags, attrs)) ??
    []
  const hiddenByTags = (profile?.selections.length ?? 0) - visibleSelections.length

  // Push the combined answers upward whenever anything changes (null while
  // the profile loads so the parent never submits a previous template's
  // answers; parents disable their submit button until non-null). Overrides
  // are only emitted for visible selections — tag-hidden ones are excluded
  // server-side by the same matcher.
  useEffect(() => {
    if (loadError) {
      onChangeRef.current({ status: "error" })
      return
    }
    if (!profile) {
      onChangeRef.current(null)
      return
    }
    onChangeRef.current({
      status: "ready",
      attributes: attrs,
      selection_overrides: profile.selections
        .filter((s) => matchesTemplateTags(s.template_tags, attrs))
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
  }, [profile, loadError, attrs, included, allowanceText])

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
  if (profile.tags.length === 0 && profile.selections.length === 0) {
    return null
  }

  return (
    <div className="space-y-4">
      {profile.tags.length > 0 && (
        <div>
          <Label>House attributes</Label>
          <p className="text-xs text-muted mb-2">
            Check what applies to this build — template items conditioned on
            these (waterproofing for a walkout, etc.) are only copied when
            they match.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1.5">
            {profile.tags.map((tag) => (
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
              by the house attributes above.
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

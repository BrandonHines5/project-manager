"use client"

import { useMemo, useState, useTransition } from "react"
import { toast } from "sonner"
import { Plus, Trash2, X } from "lucide-react"
import { Card, CardBody } from "@/components/ui/card"
import { Field, Input, Label } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { saveTemplateTagConfig } from "@/app/actions/settings"
import {
  baseTag,
  normalizeTag,
  tagLabel,
  type TemplateTagGroup,
} from "@/lib/template-tags"

export function TemplateTagsSettingsClient({
  initialGroups,
  existingTags,
}: {
  initialGroups: TemplateTagGroup[]
  existingTags: string[]
}) {
  const [groups, setGroups] = useState<TemplateTagGroup[]>(initialGroups)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [pending, startTransition] = useTransition()

  function updateGroup(id: string, patch: Partial<TemplateTagGroup>) {
    setGroups((gs) => gs.map((g) => (g.id === id ? { ...g, ...patch } : g)))
  }
  function addGroup() {
    setGroups((gs) => [
      ...gs,
      { id: crypto.randomUUID(), label: "", required: false, options: [] },
    ])
  }
  function removeGroup(id: string) {
    setGroups((gs) => gs.filter((g) => g.id !== id))
  }
  function addOption(id: string, raw: string) {
    const tag = baseTag(normalizeTag(raw))
    if (!tag) return
    setGroups((gs) =>
      gs.map((g) =>
        g.id === id && !g.options.includes(tag)
          ? { ...g, options: [...g.options, tag] }
          : g
      )
    )
    setDrafts((d) => ({ ...d, [id]: "" }))
  }
  function removeOption(id: string, tag: string) {
    setGroups((gs) =>
      gs.map((g) =>
        g.id === id ? { ...g, options: g.options.filter((o) => o !== tag) } : g
      )
    )
  }

  // Mirror the server's save rules so the disabled Save button explains itself:
  // every group needs a name and at least two options (a real either/or).
  const problems = useMemo(() => {
    const list: string[] = []
    for (const g of groups) {
      const name = g.label.trim() || "(unnamed group)"
      if (!g.label.trim()) list.push("Every group needs a name.")
      if (g.options.length < 2)
        list.push(`"${name}" needs at least two options.`)
    }
    return [...new Set(list)]
  }, [groups])

  function save() {
    startTransition(async () => {
      const res = await saveTemplateTagConfig({
        groups: groups.map((g) => ({
          id: g.id,
          label: g.label.trim(),
          required: g.required,
          options: g.options,
        })),
      })
      if (res.ok) toast.success("Template tags saved")
      else toast.error(res.error)
    })
  }

  return (
    <div className="max-w-3xl mx-auto px-4 md:px-6 py-6">
      <div className="mb-4">
        <h1 className="text-2xl font-semibold tracking-tight">Template tags</h1>
        <p className="text-sm text-muted">
          Group template tags into either/or choices (e.g. Single Level vs
          Multi Level). Mark a group <strong>required</strong> and staff must
          pick one when creating a project from a template before it can be
          created.
        </p>
      </div>

      <div className="space-y-3">
        {groups.length === 0 && (
          <Card>
            <CardBody className="text-sm text-muted">
              No tag groups yet. Add one to turn a set of template tags into a
              required either/or choice at project creation.
            </CardBody>
          </Card>
        )}
        {groups.map((g) => (
          <GroupCard
            key={g.id}
            group={g}
            draft={drafts[g.id] ?? ""}
            existingTags={existingTags}
            onLabel={(label) => updateGroup(g.id, { label })}
            onRequired={(required) => updateGroup(g.id, { required })}
            onDraft={(v) => setDrafts((d) => ({ ...d, [g.id]: v }))}
            onAddOption={(raw) => addOption(g.id, raw)}
            onRemoveOption={(tag) => removeOption(g.id, tag)}
            onRemoveGroup={() => removeGroup(g.id)}
          />
        ))}
      </div>

      <div className="mt-4 flex items-center justify-between gap-3">
        <Button type="button" variant="secondary" onClick={addGroup}>
          <Plus className="h-4 w-4" /> Add group
        </Button>
        <Button
          type="button"
          onClick={save}
          disabled={pending || problems.length > 0}
        >
          {pending ? "Saving…" : "Save changes"}
        </Button>
      </div>
      {problems.length > 0 && (
        <p className="mt-2 text-right text-xs text-danger">{problems[0]}</p>
      )}
    </div>
  )
}

function GroupCard({
  group,
  draft,
  existingTags,
  onLabel,
  onRequired,
  onDraft,
  onAddOption,
  onRemoveOption,
  onRemoveGroup,
}: {
  group: TemplateTagGroup
  draft: string
  existingTags: string[]
  onLabel: (v: string) => void
  onRequired: (v: boolean) => void
  onDraft: (v: string) => void
  onAddOption: (raw: string) => void
  onRemoveOption: (tag: string) => void
  onRemoveGroup: () => void
}) {
  // Existing tags not already used as an option here, offered for quick reuse
  // so the vocabulary doesn't drift into near-duplicates.
  const suggestions = existingTags.filter((t) => !group.options.includes(t))
  const draftPreview = baseTag(normalizeTag(draft))

  return (
    <Card>
      <CardBody className="space-y-3">
        <div className="flex items-start gap-3">
          <Field label="Group name" className="flex-1">
            <Input
              value={group.label}
              onChange={(e) => onLabel(e.target.value)}
              placeholder="e.g. Levels"
            />
          </Field>
          <button
            type="button"
            onClick={onRemoveGroup}
            className="mt-6 text-muted hover:text-danger cursor-pointer"
            title="Remove group"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>

        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input
            type="checkbox"
            className="h-4 w-4 accent-brand-500"
            checked={group.required}
            onChange={(e) => onRequired(e.target.checked)}
          />
          Required — staff must pick one when creating a project
        </label>

        <div>
          <Label className="mb-1">Options (staff pick exactly one)</Label>
          <div className="flex flex-wrap items-center gap-1.5">
            {group.options.map((tag) => (
              <span
                key={tag}
                className="inline-flex items-center gap-1 text-xs text-purple-700 bg-purple-50 border border-purple-500/30 px-2 py-0.5 rounded"
              >
                {tagLabel(tag)}
                <button
                  type="button"
                  onClick={() => onRemoveOption(tag)}
                  className="text-purple-400 hover:text-danger cursor-pointer"
                  aria-label={`Remove ${tag}`}
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
            {group.options.length === 0 && (
              <span className="text-xs text-muted">No options yet.</span>
            )}
          </div>
          <div className="mt-2 flex items-center gap-2">
            <Input
              value={draft}
              onChange={(e) => onDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === ",") {
                  e.preventDefault()
                  onAddOption(draft)
                }
              }}
              placeholder="e.g. single_level"
              className="max-w-xs"
            />
            <Button
              type="button"
              variant="secondary"
              onClick={() => onAddOption(draft)}
            >
              Add option
            </Button>
          </div>
          {draft.trim() && draftPreview && (
            <p className="mt-1 text-xs text-muted">
              Saved as <span className="font-mono">{draftPreview}</span>
            </p>
          )}
          {suggestions.length > 0 && (
            <div className="mt-1.5 flex flex-wrap items-center gap-1 text-[11px]">
              <span className="text-muted">Reuse:</span>
              {suggestions.slice(0, 8).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => onAddOption(t)}
                  className="rounded-full border border-border bg-surface px-2 py-0.5 font-mono text-foreground hover:border-brand-500 hover:text-brand-600 cursor-pointer"
                >
                  {t}
                </button>
              ))}
            </div>
          )}
        </div>
      </CardBody>
    </Card>
  )
}

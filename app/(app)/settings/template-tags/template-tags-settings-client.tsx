"use client"

import { useMemo, useState, useTransition } from "react"
import { toast } from "sonner"
import { Info, Plus, Trash2, X } from "lucide-react"
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
  initialTags,
  initialGroups,
  initialUsage,
}: {
  initialTags: string[]
  initialGroups: TemplateTagGroup[]
  initialUsage: Record<string, number>
}) {
  // `tags` is the explicitly-managed vocabulary; `usage` is what's actually on
  // items (counts). The displayed list is the union of both plus group options
  // so nothing that exists is ever hidden. `strip` collects tags the user
  // removed that are still on items — they're deleted from those items on save.
  const [tags, setTags] = useState<string[]>(initialTags)
  const [groups, setGroups] = useState<TemplateTagGroup[]>(initialGroups)
  const [usage, setUsage] = useState<Record<string, number>>(initialUsage)
  const [strip, setStrip] = useState<string[]>([])
  const [newTag, setNewTag] = useState("")
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [pending, startTransition] = useTransition()

  // Every tag that exists anywhere — managed vocabulary, in use on items, or
  // used as a group option — de-duped and sorted. This is the full list.
  const allTags = useMemo(() => {
    const set = new Set<string>(tags)
    for (const t of Object.keys(usage)) set.add(t)
    for (const g of groups) for (const o of g.options) set.add(o)
    return [...set].filter(Boolean).sort()
  }, [tags, usage, groups])

  // group label(s) each tag belongs to, for a hint on the tag chips.
  const groupOf = useMemo(() => {
    const map: Record<string, string[]> = {}
    for (const g of groups) {
      for (const o of g.options) (map[o] ??= []).push(g.label || "unnamed")
    }
    return map
  }, [groups])

  // Re-introducing a tag anywhere — as a vocabulary entry OR a group option —
  // must cancel any pending strip and restore its usage count. Without this, a
  // remove-then-re-add (e.g. deleting a tag, then fixing the now-1-option group
  // by re-adding it) would still strip the tag off every item on save while the
  // saved config keeps listing it, silently changing which items copy.
  function reviveTag(tag: string) {
    setStrip((cur) => cur.filter((t) => t !== tag))
    setUsage((cur) =>
      tag in cur || initialUsage[tag] == null
        ? cur
        : { ...cur, [tag]: initialUsage[tag] }
    )
  }

  function addTag(raw: string) {
    const tag = baseTag(normalizeTag(raw))
    if (!tag) return
    setNewTag("")
    if (allTags.includes(tag)) {
      toast.info(`"${tagLabel(tag)}" already exists`)
      return
    }
    setTags((cur) => [...cur, tag])
    reviveTag(tag)
  }

  function removeTag(tag: string) {
    const uses = usage[tag] ?? 0
    if (
      uses > 0 &&
      !window.confirm(
        `"${tagLabel(tag)}" is used on ${uses} item${uses === 1 ? "" : "s"}. ` +
          `Remove it? It will be deleted from those items when you save.`
      )
    ) {
      return
    }
    setTags((cur) => cur.filter((t) => t !== tag))
    setGroups((cur) =>
      cur.map((g) => ({ ...g, options: g.options.filter((o) => o !== tag) }))
    )
    setUsage((cur) => {
      const next = { ...cur }
      delete next[tag]
      return next
    })
    if (uses > 0) setStrip((cur) => (cur.includes(tag) ? cur : [...cur, tag]))
  }

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
    // A group option is a tag too — un-queue any pending strip / restore usage.
    reviveTag(tag)
  }
  function removeOption(id: string, tag: string) {
    setGroups((gs) =>
      gs.map((g) =>
        g.id === id ? { ...g, options: g.options.filter((o) => o !== tag) } : g
      )
    )
  }

  // Mirror the server's rules so the disabled Save button explains itself.
  const problems = useMemo(() => {
    const list: string[] = []
    const labels = new Set<string>()
    for (const g of groups) {
      const name = g.label.trim() || "(unnamed group)"
      if (!g.label.trim()) list.push("Every group needs a name.")
      if (g.options.length < 2)
        list.push(`"${name}" needs at least two options.`)
      const key = g.label.trim().toLowerCase()
      if (key && labels.has(key)) list.push(`Two groups are named "${name}".`)
      if (key) labels.add(key)
    }
    return [...new Set(list)]
  }, [groups])

  function save() {
    startTransition(async () => {
      const res = await saveTemplateTagConfig({
        tags,
        groups: groups.map((g) => ({
          id: g.id,
          label: g.label.trim(),
          required: g.required,
          options: g.options,
        })),
        strip,
      })
      if (res.ok) {
        setStrip([])
        toast.success(
          res.stripped > 0
            ? `Saved · removed tags from ${res.stripped} item${res.stripped === 1 ? "" : "s"}`
            : "Template tags saved"
        )
      } else {
        toast.error(res.error)
      }
    })
  }

  return (
    <div className="max-w-3xl mx-auto px-4 md:px-6 py-6">
      <div className="mb-4">
        <h1 className="text-2xl font-semibold tracking-tight">Template tags</h1>
        <p className="text-sm text-muted">
          Manage the tags used to conditionally copy template items, and group
          some into either/or choices staff answer when creating a project.
        </p>
      </div>

      <div className="mb-4 flex items-start gap-2 rounded-md border border-brand-500/20 bg-brand-50 px-3 py-2 text-sm text-brand-700">
        <Info className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          <strong>Untagged items always copy.</strong> Tag an item only when it
          should be <em>left out</em> for certain choices — e.g. tag a
          spec-only task <span className="font-mono">spec</span> so it&apos;s
          skipped on custom homes. Everything untagged comes over on every job.
        </span>
      </div>

      {/* All tags */}
      <Card>
        <CardBody className="space-y-3">
          <div>
            <Label>All template tags</Label>
            <p className="text-xs text-muted">
              Every tag that exists — in use on items, added here, or used in a
              group. Removing a tag that&apos;s in use deletes it from those
              items when you save.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {allTags.length === 0 && (
              <span className="text-sm text-muted">No tags yet.</span>
            )}
            {allTags.map((tag) => {
              const uses = usage[tag] ?? 0
              const inGroups = groupOf[tag] ?? []
              return (
                <span
                  key={tag}
                  className="inline-flex items-center gap-1.5 rounded border border-border bg-surface px-2 py-1 text-sm"
                  title={
                    inGroups.length > 0
                      ? `In group: ${inGroups.join(", ")}`
                      : undefined
                  }
                >
                  <span className="font-mono text-xs">{tag}</span>
                  <span className="text-[11px] text-muted">
                    {uses} use{uses === 1 ? "" : "s"}
                  </span>
                  {inGroups.length > 0 && (
                    <span className="text-[11px] text-purple-600">grouped</span>
                  )}
                  <button
                    type="button"
                    onClick={() => removeTag(tag)}
                    className="text-muted hover:text-danger cursor-pointer"
                    aria-label={`Remove ${tag}`}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </span>
              )
            })}
          </div>
          <div className="flex items-center gap-2">
            <Input
              value={newTag}
              onChange={(e) => setNewTag(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === ",") {
                  e.preventDefault()
                  addTag(newTag)
                }
              }}
              placeholder="Add a tag, e.g. walkout_basement"
              className="max-w-xs"
            />
            <Button type="button" variant="secondary" onClick={() => addTag(newTag)}>
              <Plus className="h-4 w-4" /> Add tag
            </Button>
            {newTag.trim() && baseTag(normalizeTag(newTag)) && (
              <span className="text-xs text-muted">
                saved as{" "}
                <span className="font-mono">{baseTag(normalizeTag(newTag))}</span>
              </span>
            )}
          </div>
        </CardBody>
      </Card>

      {/* Either/or groups */}
      <div className="mt-5 mb-2">
        <Label>Either/or groups</Label>
        <p className="text-xs text-muted">
          A required group makes staff pick one option when creating a project
          from a template. Picking one keeps items tagged with it and skips
          items tagged with the others.
        </p>
      </div>
      <div className="space-y-3">
        {groups.map((g) => (
          <GroupCard
            key={g.id}
            group={g}
            draft={drafts[g.id] ?? ""}
            allTags={allTags}
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
      <div className="mt-2 text-right text-xs">
        {problems.length > 0 && <p className="text-danger">{problems[0]}</p>}
        {problems.length === 0 && strip.length > 0 && (
          <p className="text-amber-700">
            Saving will delete {strip.length} tag{strip.length === 1 ? "" : "s"}{" "}
            from the items that use them.
          </p>
        )}
      </div>
    </div>
  )
}

function GroupCard({
  group,
  draft,
  allTags,
  onLabel,
  onRequired,
  onDraft,
  onAddOption,
  onRemoveOption,
  onRemoveGroup,
}: {
  group: TemplateTagGroup
  draft: string
  allTags: string[]
  onLabel: (v: string) => void
  onRequired: (v: boolean) => void
  onDraft: (v: string) => void
  onAddOption: (raw: string) => void
  onRemoveOption: (tag: string) => void
  onRemoveGroup: () => void
}) {
  // Existing tags not already an option here, offered for quick reuse so the
  // vocabulary doesn't drift into near-duplicates. Uncapped — all of them.
  const suggestions = allTags.filter((t) => !group.options.includes(t))
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
              <span className="text-muted">Add existing:</span>
              {suggestions.map((t) => (
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

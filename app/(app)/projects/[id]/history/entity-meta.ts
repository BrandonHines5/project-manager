import {
  DollarSign,
  File,
  FileSignature,
  FolderKanban,
  Gavel,
  Hammer,
  History,
  ListTodo,
  NotebookPen,
  Palette,
  Receipt,
  UserCheck,
  UserCog,
  Users,
  type LucideIcon,
} from "lucide-react"

// Shared by the History feed and the Recently-deleted panel — both speak the
// project_history / deleted_items entity_type vocabulary.

export type EntityMeta = {
  // Filter pill ("Work items"), row sentence ("work item"), batch sentence
  // ("work items") — kept separate so acronyms like "POs" read right.
  label: string
  singular: string
  plural: string
  icon: LucideIcon
  className: string
}

export const ENTITY_META: Record<string, EntityMeta> = {
  work_item: { label: "Work items", singular: "work item", plural: "work items", icon: Hammer, className: "text-brand-600 bg-brand-50" },
  todo: { label: "To-dos", singular: "to-do", plural: "to-dos", icon: ListTodo, className: "text-emerald-700 bg-emerald-50" },
  change_order: { label: "Change orders", singular: "change order", plural: "change orders", icon: FileSignature, className: "text-amber-700 bg-amber-50" },
  selection: { label: "Selections", singular: "selection", plural: "selections", icon: Palette, className: "text-purple-700 bg-purple-50" },
  daily_log: { label: "Daily logs", singular: "daily log", plural: "daily logs", icon: NotebookPen, className: "text-sky-700 bg-sky-50" },
  file: { label: "Files", singular: "file", plural: "files", icon: File, className: "text-zinc-600 bg-zinc-100" },
  payment: { label: "Payments", singular: "payment", plural: "payments", icon: DollarSign, className: "text-green-700 bg-green-50" },
  bid_package: { label: "Bids", singular: "bid package", plural: "bid packages", icon: Gavel, className: "text-orange-700 bg-orange-50" },
  purchase_order: { label: "POs", singular: "PO", plural: "POs", icon: Receipt, className: "text-cyan-700 bg-cyan-50" },
  member: { label: "Members", singular: "member", plural: "members", icon: Users, className: "text-blue-700 bg-blue-50" },
  role_assignment: { label: "Roles", singular: "role assignment", plural: "role assignments", icon: UserCog, className: "text-indigo-700 bg-indigo-50" },
  assignment: { label: "Assignments", singular: "assignment", plural: "assignments", icon: UserCheck, className: "text-teal-700 bg-teal-50" },
  project: { label: "Project", singular: "project", plural: "project", icon: FolderKanban, className: "text-rose-700 bg-rose-50" },
}

export function humanize(s: string) {
  return s.replace(/_/g, " ")
}

// Unknown entity types (the audit trigger may outpace this map) still render,
// just with a generic icon and a humanized name.
export function metaFor(type: string): EntityMeta {
  return (
    ENTITY_META[type] ?? {
      label: humanize(type) || "Other",
      singular: humanize(type) || "item",
      plural: `${humanize(type) || "item"}s`,
      icon: History,
      className: "text-muted bg-background",
    }
  )
}

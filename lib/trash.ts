// Shared shapes for "Recently deleted" (migration 0088). The capture trigger
// snapshots a deleted entity + its children into deleted_items.payload; the
// restore action in app/actions/trash.ts rebuilds the rows from it.

export const TRASH_RETENTION_DAYS = 30

/** A snapshotted table row — jsonb from `to_jsonb(row)`, keys = columns. */
export type SnapshotRow = Record<string, unknown>

export type TrashPayload = {
  row: SnapshotRow
  children?: Record<string, SnapshotRow[]>
  links?: {
    /** Decisions whose due date was anchored to the deleted schedule item. */
    anchored_decisions?: {
      id: string
      schedule_item_id: string
      due_anchor: "start" | "end"
      due_anchor_offset_days: number
    }[]
    /** Follow-up templates anchored to the deleted schedule item. */
    anchored_followup_templates?: {
      id: string
      schedule_item_id: string
      parent_anchor: "start" | "end"
      parent_offset_days: number
    }[]
    /** Materialization junction rows that pointed at the deleted item. */
    materializations?: {
      decision_id: string
      template_id: string
      schedule_item_id: string
    }[]
    /** Schedule items that were created from the deleted decision. */
    source_linked_items?: string[]
  }
}

/** Whole days until a trash entry is purged (0 = expiring today). */
export function trashDaysLeft(deletedAt: string): number {
  const expiresAt =
    new Date(deletedAt).getTime() + TRASH_RETENTION_DAYS * 86_400_000
  return Math.max(0, Math.ceil((expiresAt - Date.now()) / 86_400_000))
}

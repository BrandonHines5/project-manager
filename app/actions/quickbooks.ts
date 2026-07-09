"use server"

import { revalidatePath } from "next/cache"
import { requireStaff } from "@/lib/auth"
import {
  getQboConnection,
  getQboStatus,
  deleteQboConnection,
  type QboConnectionStatus,
} from "@/lib/quickbooks/storage"
import { revokeToken } from "@/lib/quickbooks/oauth"
import { fetchDiagnosticSnapshot } from "@/lib/quickbooks/client"

/** Redacted connection status for the settings page. */
export async function qboStatusAction(): Promise<QboConnectionStatus | null> {
  await requireStaff()
  return getQboStatus()
}

/** Disconnect: revoke the refresh token at Intuit, then drop the stored row. */
export async function disconnectQboAction(): Promise<{ ok: boolean; error?: string }> {
  await requireStaff()
  const conn = await getQboConnection()
  if (!conn) return { ok: true }
  await revokeToken(conn.refresh_token)
  const deleted = await deleteQboConnection(conn.realm_id)
  revalidatePath("/settings/quickbooks")
  return deleted ? { ok: true } : { ok: false, error: "Could not remove the stored connection." }
}

export type QboDiagnosticResult =
  | { ok: true; snapshot: Awaited<ReturnType<typeof fetchDiagnosticSnapshot>> }
  | { ok: false; error: string }

/**
 * Read-only connection check: pulls the company profile plus a sample of
 * vendors, accounts, items, and one example PurchaseOrder so we can see exactly
 * how the connected file structures a PO before building the push (Phase 2).
 * `exampleDocNumber` targets a specific PO (e.g. the manually-created "1001").
 */
export async function runQboDiagnosticAction(
  exampleDocNumber?: string
): Promise<QboDiagnosticResult> {
  await requireStaff()
  const conn = await getQboConnection()
  if (!conn) return { ok: false, error: "QuickBooks is not connected." }
  try {
    const snapshot = await fetchDiagnosticSnapshot(exampleDocNumber?.trim() || undefined)
    return { ok: true, snapshot }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

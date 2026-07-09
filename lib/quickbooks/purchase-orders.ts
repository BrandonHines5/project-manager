import "server-only"
import {
  qboPost,
  findPurchaseOrderByDocNumber,
  type QboRef,
} from "./client"

/**
 * Builds and creates a QuickBooks PurchaseOrder from one of our POs, mirroring
 * the structure of the connected file (Item-based lines + Customer + Class, per
 * the connection diagnostic). v1 uses fixed "push defaults" for the line Item /
 * Customer / Class because the test company (L2F) is a rental entity whose
 * Items don't line up with Hines cost codes — real per-cost-code mapping lands
 * when Hines migrates to QBO.
 *
 * DocNumber is our PO number: that's the reference Adaptive's bill-matcher keys
 * on. Idempotent — an existing PO with the same DocNumber is returned rather
 * than duplicated.
 */

export type PoLineInput = {
  description: string
  quantity: number
  unit_cost: number
}

export type PoInput = {
  purchase_order_id: string
  doc_number: string
  vendor_id: string
  ap_account_id: string
  private_note?: string | null
  txn_date?: string | null // YYYY-MM-DD
  flat_fee: boolean
  flat_total?: number | null
  lines: PoLineInput[]
}

export type PushDefaults = {
  item_id: string
  customer_id?: string | null
  class_id?: string | null
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

function lineDetail(defaults: PushDefaults, qty: number, unitPrice: number) {
  const detail: {
    ItemRef: QboRef
    UnitPrice: number
    Qty: number
    TaxCodeRef: QboRef
    BillableStatus: string
    CustomerRef?: QboRef
    ClassRef?: QboRef
  } = {
    ItemRef: { value: defaults.item_id },
    UnitPrice: unitPrice,
    Qty: qty,
    TaxCodeRef: { value: "NON" },
    BillableStatus: "NotBillable",
  }
  if (defaults.customer_id) detail.CustomerRef = { value: defaults.customer_id }
  if (defaults.class_id) detail.ClassRef = { value: defaults.class_id }
  return detail
}

/** Build the QBO PurchaseOrder request body. */
export function buildPurchaseOrderPayload(po: PoInput, defaults: PushDefaults) {
  const lines =
    po.flat_fee || po.lines.length === 0
      ? [
          {
            DetailType: "ItemBasedExpenseLineDetail" as const,
            Amount: round2(po.flat_total ?? 0),
            Description: po.private_note || "Flat fee",
            ItemBasedExpenseLineDetail: lineDetail(defaults, 1, round2(po.flat_total ?? 0)),
          },
        ]
      : po.lines.map((l) => {
          const amount = round2(l.quantity * l.unit_cost)
          return {
            DetailType: "ItemBasedExpenseLineDetail" as const,
            Amount: amount,
            Description: l.description,
            ItemBasedExpenseLineDetail: lineDetail(defaults, l.quantity, round2(l.unit_cost)),
          }
        })

  const body: Record<string, unknown> = {
    DocNumber: po.doc_number,
    VendorRef: { value: po.vendor_id },
    APAccountRef: { value: po.ap_account_id },
    Line: lines,
  }
  if (po.txn_date) body.TxnDate = po.txn_date
  if (po.private_note) body.PrivateNote = po.private_note
  return body
}

export type CreatePoResult = {
  qbo_po_id: string
  sync_token: string
  doc_number: string
  already_existed: boolean
}

/**
 * Find-or-create the PurchaseOrder in QBO. Returns the existing PO (matched by
 * DocNumber) untouched if one is already there, so a re-push never duplicates.
 */
export async function createPurchaseOrder(
  po: PoInput,
  defaults: PushDefaults
): Promise<CreatePoResult> {
  const existing = await findPurchaseOrderByDocNumber(po.doc_number)
  if (existing) {
    return {
      qbo_po_id: existing.Id,
      sync_token: existing.SyncToken,
      doc_number: po.doc_number,
      already_existed: true,
    }
  }

  const payload = buildPurchaseOrderPayload(po, defaults)
  // RequestId keyed on our PO id → Intuit replays the original response on a
  // rapid retry instead of creating a second PO.
  const json = (await qboPost(
    `purchaseorder?requestid=${encodeURIComponent(po.purchase_order_id)}`,
    payload
  )) as { PurchaseOrder?: { Id?: string; SyncToken?: string } }

  const created = json?.PurchaseOrder
  if (!created?.Id) {
    throw new Error("QuickBooks did not return a PurchaseOrder id")
  }
  return {
    qbo_po_id: created.Id,
    sync_token: created.SyncToken ?? "0",
    doc_number: po.doc_number,
    already_existed: false,
  }
}

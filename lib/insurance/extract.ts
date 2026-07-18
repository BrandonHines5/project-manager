import "server-only"
import Anthropic from "@anthropic-ai/sdk"

// Claude reads a vendor document — usually a certificate of insurance (ACORD
// 25 PDF or a photo/scan), but W9s and Subcontractor Master Agreements arrive
// through the same inboxes — classifies what it is, and extracts the company
// it belongs to (plus the policies, for certificates) in a fixed JSON shape.
// Structured outputs (`output_config.format`) guarantee the response parses —
// no regex-fishing in prose. Opus is worth it here: COIs are dense forms and
// a mis-read expiration date defeats the whole point of the tracker.
const MODEL = "claude-opus-4-8"

export type VendorDocKind = "coi" | "w9" | "sma" | "other"

export type ExtractedPolicy = {
  type: "general_liability" | "workers_comp" | "auto" | "umbrella"
  carrier: string | null
  policy_number: string | null
  effective_date: string | null
  expiration_date: string | null
  limits: { label: string; amount: number | null }[]
}

export type VendorDocExtraction = {
  // What the document IS. Older stored extractions predate this field —
  // readers must fall back to the row's doc_kind, never assume it's present.
  doc_kind: VendorDocKind
  company_name: string | null
  // The ACORD "Producer" — the insurance AGENCY that issued the certificate,
  // plus its contact details when printed. Used to auto-fill the company's
  // insurance-agent contact so cert requests can be CC'd to the agent.
  // COI-only; null on other document kinds.
  producer_name?: string | null
  producer_email?: string | null
  producer_phone?: string | null
  policies: ExtractedPolicy[]
}

// Media types Claude can read directly. PDFs go in as a document block,
// images as an image block; everything else is rejected by the caller.
export const EXTRACTABLE_PDF = "application/pdf"
export const EXTRACTABLE_IMAGES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
] as const

export function isExtractableType(mediaType: string | null): boolean {
  if (!mediaType) return false
  return (
    mediaType === EXTRACTABLE_PDF ||
    (EXTRACTABLE_IMAGES as readonly string[]).includes(mediaType)
  )
}

const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "doc_kind",
    "company_name",
    "producer_name",
    "producer_email",
    "producer_phone",
    "policies",
  ],
  properties: {
    doc_kind: {
      type: "string",
      enum: ["coi", "w9", "sma", "other"],
      description:
        "What this document is: coi = certificate of insurance (ACORD 25 or " +
        "similar), w9 = IRS Form W-9, sma = subcontractor master agreement " +
        "(a contract between the builder and a subcontractor), other = none " +
        "of these.",
    },
    company_name: {
      anyOf: [{ type: "string" }, { type: "null" }],
      description:
        "The subcontractor/vendor business name the document belongs to. " +
        "For a COI: the INSURED (not the producer/agent, not the " +
        "certificate holder). For a W-9: the business name (line 2) when " +
        "present, else the line 1 name. For an SMA: the subcontractor party.",
    },
    producer_name: {
      anyOf: [{ type: "string" }, { type: "null" }],
      description:
        "COI only — the PRODUCER's name: the insurance agency (and contact " +
        "person, if printed) that issued the certificate. Null for non-COI " +
        "documents.",
    },
    producer_email: {
      anyOf: [{ type: "string" }, { type: "null" }],
      description: "COI only — the producer's email address, if printed.",
    },
    producer_phone: {
      anyOf: [{ type: "string" }, { type: "null" }],
      description: "COI only — the producer's phone number, if printed.",
    },
    policies: {
      type: "array",
      description: "COI only — empty for non-COI documents.",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "type",
          "carrier",
          "policy_number",
          "effective_date",
          "expiration_date",
          "limits",
        ],
        properties: {
          type: {
            type: "string",
            enum: ["general_liability", "workers_comp", "auto", "umbrella"],
          },
          carrier: {
            anyOf: [{ type: "string" }, { type: "null" }],
            description: "The insurer/carrier name for this policy.",
          },
          policy_number: { anyOf: [{ type: "string" }, { type: "null" }] },
          effective_date: {
            anyOf: [{ type: "string", format: "date" }, { type: "null" }],
            description: "Policy effective date as YYYY-MM-DD.",
          },
          expiration_date: {
            anyOf: [{ type: "string", format: "date" }, { type: "null" }],
            description: "Policy expiration date as YYYY-MM-DD.",
          },
          limits: {
            type: "array",
            description:
              "Coverage limits printed for this policy, e.g. " +
              '{"label": "Each Occurrence", "amount": 1000000}.',
            items: {
              type: "object",
              additionalProperties: false,
              required: ["label", "amount"],
              properties: {
                label: { type: "string" },
                amount: { anyOf: [{ type: "number" }, { type: "null" }] },
              },
            },
          },
        },
      },
    },
  },
} as const

const PROMPT = `This file is a document from or about one of our subcontractors/vendors. First classify what it is (doc_kind):

- "coi" — a certificate of insurance (often an ACORD 25 form, sometimes a state workers'-comp certificate or another carrier form).
- "w9" — an IRS Form W-9 (Request for Taxpayer Identification Number and Certification).
- "sma" — a subcontractor master agreement: a signed contract between the builder (Hines Homes) and a subcontractor covering their ongoing work. Also called a master subcontract agreement.
- "other" — anything else.

Then extract:

1. company_name — the subcontractor/vendor the document belongs to:
   - coi: the INSURED's business name. Not the producer/agency and not the certificate holder.
   - w9: the business/disregarded-entity name (line 2) when filled in, otherwise the name on line 1.
   - sma: the subcontractor party to the agreement (never Hines Homes itself).
   - other: the vendor the document appears to be from or about, or null.
2. producer_name / producer_email / producer_phone — COI only: the PRODUCER block — the insurance agency that issued the certificate and its printed contact details (null for anything not printed, and null on non-COI documents).
3. policies — COI only: one entry per policy listed. Map coverage rows to types:
   - "Commercial General Liability" → general_liability
   - "Workers Compensation and Employers' Liability" → workers_comp
   - "Automobile Liability" (any auto) → auto
   - "Umbrella Liab" / "Excess Liab" → umbrella
   Ignore other coverage types (professional, pollution, etc.).
   A certificate may list only ONE coverage type (e.g. a workers'-comp-only certificate — GL and WC often arrive on separate documents with different expiration dates). Extract whatever is present; a single policy is a perfectly valid result.
   For non-COI documents, return an empty policies array.

Dates must be YYYY-MM-DD. If a field is blank or illegible, use null — never guess.`

/**
 * Runs Claude over a vendor document and returns the structured extraction
 * (classification + company + policies for certificates). Throws on missing
 * API key or API failure — callers (the ingest pipeline) catch and mark the
 * document `failed` rather than letting a webhook 500.
 *
 * `opts.confirmedKind` skips the classification question: staff have told us
 * what the document is (e.g. correcting a misclassified certificate in the
 * review queue), so the model extracts under that assumption instead of
 * re-deciding — a cert the classifier mistook for something else would
 * otherwise come back with an intentionally empty policies array.
 */
export async function extractVendorDocument(
  bytes: Buffer,
  mediaType: string,
  opts?: { confirmedKind?: VendorDocKind }
): Promise<VendorDocExtraction> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not configured")
  }
  // Fail fast locally instead of shipping an unsupported media type to the
  // API — the cast in the image branch below is only safe after this check.
  if (!isExtractableType(mediaType)) {
    throw new Error(`Unsupported media type for extraction: ${mediaType}`)
  }
  const client = new Anthropic({ apiKey })

  const fileBlock: Anthropic.ContentBlockParam =
    mediaType === EXTRACTABLE_PDF
      ? {
          type: "document",
          source: {
            type: "base64",
            media_type: "application/pdf",
            data: bytes.toString("base64"),
          },
        }
      : {
          type: "image",
          source: {
            type: "base64",
            media_type: mediaType as (typeof EXTRACTABLE_IMAGES)[number],
            data: bytes.toString("base64"),
          },
        }

  const prompt = opts?.confirmedKind
    ? `${PROMPT}\n\nNote: our staff have confirmed this document IS doc_kind "${opts.confirmedKind}" — classify it as that kind and extract accordingly (for "coi", extract every policy present).`
    : PROMPT

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    output_config: {
      format: {
        type: "json_schema",
        // OUTPUT_SCHEMA is `as const` for our own reading; the SDK's schema
        // type wants a plain mutable JSONSchema shape.
        schema: OUTPUT_SCHEMA as unknown as Record<string, unknown>,
      },
    },
    messages: [
      {
        role: "user",
        content: [fileBlock, { type: "text", text: prompt }],
      },
    ],
  })

  if (response.stop_reason === "refusal") {
    throw new Error("Model declined to process this document")
  }
  const text = response.content.find((b) => b.type === "text")
  if (!text || text.type !== "text") {
    throw new Error("Model returned no structured output")
  }
  const parsed = JSON.parse(text.text) as VendorDocExtraction
  return {
    doc_kind: parsed.doc_kind ?? "other",
    company_name: parsed.company_name ?? null,
    producer_name: parsed.producer_name ?? null,
    producer_email: parsed.producer_email ?? null,
    producer_phone: parsed.producer_phone ?? null,
    policies: (parsed.policies ?? []).filter(Boolean),
  }
}

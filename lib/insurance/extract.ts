import "server-only"
import Anthropic from "@anthropic-ai/sdk"

// Claude reads a certificate of insurance (usually an ACORD 25 PDF, sometimes
// a photo/scan) and returns the policies on it in a fixed JSON shape.
// Structured outputs (`output_config.format`) guarantee the response parses —
// no regex-fishing in prose. Opus is worth it here: COIs are dense forms and
// a mis-read expiration date defeats the whole point of the tracker.
const MODEL = "claude-opus-4-8"

export type ExtractedPolicy = {
  type: "general_liability" | "workers_comp" | "auto" | "umbrella"
  carrier: string | null
  policy_number: string | null
  effective_date: string | null
  expiration_date: string | null
  limits: { label: string; amount: number | null }[]
}

export type CoiExtraction = {
  company_name: string | null
  // The ACORD "Producer" — the insurance AGENCY that issued the certificate,
  // plus its contact details when printed. Used to auto-fill the company's
  // insurance-agent contact so cert requests can be CC'd to the agent.
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
    "company_name",
    "producer_name",
    "producer_email",
    "producer_phone",
    "policies",
  ],
  properties: {
    company_name: {
      anyOf: [{ type: "string" }, { type: "null" }],
      description:
        "The INSURED's business name exactly as printed on the certificate " +
        "(not the producer/agent, not the certificate holder).",
    },
    producer_name: {
      anyOf: [{ type: "string" }, { type: "null" }],
      description:
        "The PRODUCER's name — the insurance agency (and contact person, if " +
        "printed) that issued the certificate.",
    },
    producer_email: {
      anyOf: [{ type: "string" }, { type: "null" }],
      description: "The producer's email address, if printed.",
    },
    producer_phone: {
      anyOf: [{ type: "string" }, { type: "null" }],
      description: "The producer's phone number, if printed.",
    },
    policies: {
      type: "array",
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

const PROMPT = `This file should be a certificate of insurance (often an ACORD 25 form, sometimes a state workers'-comp certificate or another carrier form) for one of our subcontractors. Read it and extract:

1. company_name — the INSURED's business name (the subcontractor). Not the producer/agency and not the certificate holder.
2. producer_name / producer_email / producer_phone — the PRODUCER block: the insurance agency that issued the certificate and its printed contact details (null for anything not printed).
3. policies — one entry per policy listed. Map coverage rows to types:
   - "Commercial General Liability" → general_liability
   - "Workers Compensation and Employers' Liability" → workers_comp
   - "Automobile Liability" (any auto) → auto
   - "Umbrella Liab" / "Excess Liab" → umbrella
   Ignore other coverage types (professional, pollution, etc.).
   A certificate may list only ONE coverage type (e.g. a workers'-comp-only certificate — GL and WC often arrive on separate documents with different expiration dates). Extract whatever is present; a single policy is a perfectly valid result.

Dates must be YYYY-MM-DD. If a policy row is present but a field is blank or illegible, use null for that field — never guess. If the document is not an insurance certificate at all, return an empty policies array and null company_name.`

/**
 * Runs Claude over a COI file and returns the structured extraction.
 * Throws on missing API key or API failure — callers (the ingest pipeline)
 * catch and mark the document `failed` rather than letting a webhook 500.
 */
export async function extractCoi(
  bytes: Buffer,
  mediaType: string
): Promise<CoiExtraction> {
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
        content: [fileBlock, { type: "text", text: PROMPT }],
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
  const parsed = JSON.parse(text.text) as CoiExtraction
  return {
    company_name: parsed.company_name ?? null,
    producer_name: parsed.producer_name ?? null,
    producer_email: parsed.producer_email ?? null,
    producer_phone: parsed.producer_phone ?? null,
    policies: (parsed.policies ?? []).filter(Boolean),
  }
}

import "server-only"
import Anthropic from "@anthropic-ai/sdk"

// Files a batch of synced Outlook emails to jobs — or to no job at all.
//
// The counterparty heuristics that place phone traffic (single active
// engagement, recent conversation) misfile email badly: a utility company or
// lender corresponds about MANY jobs while being formally engaged on one, so
// "130 Eagle Ridge" mail landed on 83 Calion Court's tab. Email carries its
// own evidence — subject lines and bodies name addresses, job numbers, and
// clients — so a model reads the content and files each message only when it
// confidently identifies the job. Anything ambiguous stays global-hub-only,
// where staff can file it by hand.
//
// Single-shot batched call (the client-update / COI-extractor shape), with
// structured outputs so the response always parses. Sonnet-tier: this is
// matching text against a short list, not dense-form reading.
const MODEL = "claude-sonnet-5"

export type JobForMatching = {
  id: string
  project_number: string
  name: string
  address: string | null
  client_name: string | null
  client_name_2: string | null
}

export type EmailForMatching = {
  /** Caller-side correlation key (the communications row id). */
  key: string
  direction: "inbound" | "outbound"
  subject: string | null
  body_preview: string | null
  counterparty_name: string | null
  /**
   * What the engagement heuristics would have guessed (a project id) —
   * supporting evidence the model may combine with consistent content,
   * never a stamp.
   */
  suggested_project_id: string | null
}

const SYSTEM = `You file a home builder's emails to the correct construction job (project), or to no job.

You are given the builder's job list (number, name, address, client names) and a batch of emails (subject, body preview, counterparty, direction). For each email, decide which ONE job it is about, or null.

Rules:
- Match on the CONTENT: a job's address (full or distinctive fragment like "83 Calion"), its job number, its name, or its client's name appearing in the subject or body is strong evidence.
- Some emails include a "suggested job" — the job the counterparty is formally engaged on. That is supporting evidence ONLY: use it when the content is consistent with it (e.g. the builder's client asking a question about their own build). If the content references a DIFFERENT address or job than the suggestion, or the message is clearly not about job work, ignore the suggestion.
- An email that names an address or job that is NOT in the job list belongs to none of these jobs: return null. Never file mail about one property to a different property.
- Generic business mail (invoices without a property reference, scheduling chatter naming no job, newsletters, statements covering many jobs) gets null.
- When torn between two jobs, return null — a wrong filing is worse than an unfiled email.
- Return a decision for EVERY email in the batch, keyed by its id, with project_id copied exactly from the job list or null.`

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    matches: {
      type: "array",
      items: {
        type: "object",
        properties: {
          key: { type: "string" },
          project_id: { type: ["string", "null"] },
        },
        required: ["key", "project_id"],
        additionalProperties: false,
      },
    },
  },
  required: ["matches"],
  additionalProperties: false,
} as const

function jobsBlock(jobs: JobForMatching[]): string {
  return jobs
    .map((j) => {
      const clients = [j.client_name, j.client_name_2]
        .filter(Boolean)
        .join(" & ")
      return [
        `- project_id: ${j.id}`,
        `  number: ${j.project_number}`,
        `  name: ${j.name}`,
        j.address ? `  address: ${j.address}` : null,
        clients ? `  client: ${clients}` : null,
      ]
        .filter(Boolean)
        .join("\n")
    })
    .join("\n")
}

function emailsBlock(
  emails: EmailForMatching[],
  jobById: Map<string, JobForMatching>
): string {
  return emails
    .map((e) => {
      const suggested = e.suggested_project_id
        ? jobById.get(e.suggested_project_id)
        : null
      return [
        `- id: ${e.key}`,
        `  direction: ${e.direction}`,
        `  counterparty: ${e.counterparty_name ?? "(unknown)"}`,
        suggested
          ? `  suggested job (engagement heuristic): ${suggested.project_number} ${suggested.name}`
          : null,
        `  subject: ${(e.subject ?? "").slice(0, 300) || "(none)"}`,
        `  body preview: ${(e.body_preview ?? "").slice(0, 600) || "(none)"}`,
      ]
        .filter(Boolean)
        .join("\n")
    })
    .join("\n")
}

/**
 * Classify a batch of emails against the org's job list. Returns a map of
 * email key → project_id (null = file to no job). Keys the model omitted or
 * answered with an unknown project_id are ABSENT from the map — callers must
 * treat absence as "not classified" (retry later), not as "no job".
 * Throws on missing API key / API failure, so a broken key never silently
 * files everything to null.
 */
export async function classifyEmailJobs(
  emails: EmailForMatching[],
  jobs: JobForMatching[]
): Promise<Map<string, string | null>> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not configured")
  if (emails.length === 0) return new Map()

  const jobById = new Map(jobs.map((j) => [j.id, j]))

  // 90s: a cron caller batches ~20 emails per call and has its own overall
  // time budget — fail this call fast enough that one hang can't eat the run.
  const client = new Anthropic({ apiKey, timeout: 90_000 })
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 8192,
    thinking: { type: "adaptive" },
    output_config: {
      format: {
        type: "json_schema",
        schema: OUTPUT_SCHEMA as unknown as Record<string, unknown>,
      },
    },
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `${SYSTEM}\n\nJOBS:\n${jobsBlock(jobs)}\n\nEMAILS:\n${emailsBlock(emails, jobById)}`,
          },
        ],
      },
    ],
  })
  if (response.stop_reason === "refusal") {
    throw new Error("Model declined to classify this batch")
  }
  const text = response.content.find((b) => b.type === "text")
  if (!text || text.type !== "text") {
    throw new Error("Model returned no structured output")
  }
  const parsed = JSON.parse(text.text) as {
    matches: { key: string; project_id: string | null }[]
  }

  const wanted = new Set(emails.map((e) => e.key))
  const result = new Map<string, string | null>()
  for (const m of parsed.matches ?? []) {
    if (!wanted.has(m.key)) continue
    // A hallucinated project_id must not become a stamp — drop the entry
    // entirely so the row stays unclassified and retries next sweep.
    if (m.project_id !== null && !jobById.has(m.project_id)) continue
    result.set(m.key, m.project_id)
  }
  return result
}

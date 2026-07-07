import "server-only"
import Anthropic from "@anthropic-ai/sdk"

// Rewrites a week of raw internal job notes into a warm, homeowner-friendly
// progress update. A single-shot call (no tool loop) — the same shape as the
// insurance COI extractor. Sonnet-tier is plenty for prose rewriting.
const MODEL = "claude-sonnet-5"

export type ClientUpdateFacts = {
  project_name: string
  address: string | null
  // Internal daily-log notes in the chosen window, oldest first.
  logs: { date: string; notes: string }[]
  // Work items that completed in the window.
  completed: { title: string; end_date: string | null }[]
  // Work items starting soon (look-ahead).
  upcoming: { title: string; start_date: string | null }[]
}

const SYSTEM = `You write short, warm progress updates that a home builder (Hines Homes) sends to the homeowner client about their construction project. You are given raw INTERNAL job-site notes plus recently completed and upcoming schedule items. Rewrite them into a single client-facing update.

Rules:
- Audience is the homeowner, not staff. Write in plain, friendly, professional language — first person plural ("we", "our team").
- Summarize progress and what's coming next. Lead with what got done.
- STRIP anything internal: subcontractor complaints or blame, dollar amounts and costs, internal shorthand and abbreviations, staff names, and any negative remarks about trades or vendors. Reframe problems as neutral status ("the framing inspection is being rescheduled") rather than venting.
- Do not invent facts. Only use what's in the notes and schedule items. If there's very little to report, keep it brief and honest.
- No greeting line with the client's name and no signature — the builder adds those. Just the body of the update, a few short paragraphs or a tight bulleted list.
- Keep it under ~200 words.
- Output ONLY the update text — no preamble, no "Here is the update:", no markdown headers.`

function buildUserMessage(facts: ClientUpdateFacts): string {
  const parts: string[] = []
  parts.push(`Project: ${facts.project_name}${facts.address ? ` (${facts.address})` : ""}`)
  if (facts.completed.length) {
    parts.push(
      "Recently completed:\n" +
        facts.completed
          .map((c) => `- ${c.title}${c.end_date ? ` (${c.end_date})` : ""}`)
          .join("\n")
    )
  }
  if (facts.upcoming.length) {
    parts.push(
      "Coming up:\n" +
        facts.upcoming
          .map((u) => `- ${u.title}${u.start_date ? ` (starts ${u.start_date})` : ""}`)
          .join("\n")
    )
  }
  if (facts.logs.length) {
    parts.push(
      "Internal daily-log notes (rewrite, don't quote):\n" +
        facts.logs.map((l) => `[${l.date}] ${l.notes}`).join("\n\n")
    )
  } else {
    parts.push("(No daily-log notes in this window.)")
  }
  return parts.join("\n\n")
}

/**
 * Runs Claude over the window's facts and returns a homeowner-friendly draft.
 * Throws on missing API key / API failure / refusal — the caller (a server
 * action) catches and returns a typed error rather than letting it 500.
 */
export async function composeClientUpdate(
  facts: ClientUpdateFacts
): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not configured")
  }
  // 60s timeout: this backs a button in the UI, so failing fast beats the
  // SDK's multi-minute default leaving the spinner hanging. A ~200-word
  // draft over a week of notes completes in a fraction of this.
  const client = new Anthropic({ apiKey, timeout: 60_000 })
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    thinking: { type: "adaptive" },
    system: SYSTEM,
    messages: [{ role: "user", content: buildUserMessage(facts) }],
  })
  if (response.stop_reason === "refusal") {
    throw new Error("The model declined to draft this update.")
  }
  if (response.stop_reason === "max_tokens") {
    // Don't hand a silently-truncated draft to the drawer.
    throw new Error(
      "The draft was cut off before it finished. Try a narrower date range."
    )
  }
  const text = response.content
    .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim()
  if (!text) {
    throw new Error("The model returned an empty draft.")
  }
  return text
}

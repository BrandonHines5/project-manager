// Help-desk knowledge base for the AI assistant.
//
// The AI agent (lib/ai/agent.ts) doubles as an in-app help desk: staff can
// ask "how does X work?" / "how do I do Y?" and get an accurate, plain-English
// answer about the app's own features. These topics are the source of truth
// the model draws on. They describe the product from a STAFF USER's point of
// view — what a feature does, where to find it, and the workflow — not the
// implementation (no RLS, migrations, table names). Keep them in sync with
// the real UI when features change.
//
// How it's wired:
//   - `helpCatalog()` renders the id + title + summary of every topic into
//     the system prompt, so the model always knows the full menu of what it
//     can explain.
//   - The `search_help_topics` tool (see agent.ts) returns full `body` text
//     for the topics matching a query or requested by id, so the model can
//     pull details on demand without bloating every prompt.

export type HelpTopic = {
  id: string
  title: string
  // One line for the in-prompt catalog.
  summary: string
  // Extra search terms beyond the words already in the title/summary/body.
  keywords: string[]
  // The full staff-facing explanation returned by search_help_topics.
  body: string
}

export const HELP_TOPICS: HelpTopic[] = [
  {
    id: "overview",
    title: "What this app is & how it's organized",
    summary:
      "The big picture: what the software does and the main areas of the app.",
    keywords: [
      "overview",
      "navigation",
      "menu",
      "sections",
      "getting started",
      "home",
      "what can this do",
      "modules",
    ],
    body: `Hines Homes' project management system runs your construction jobs end to end — schedule, client decisions, daily logs, subcontractor bidding, purchase orders, and subcontractor insurance tracking — in one place.

Main areas (top navigation):
- Projects: every job. Open a project to reach its tabs: Overview, Schedule, Decisions, Daily Logs, Bids, Purchase Orders, Pricing, Files, Roles, History, Onsite, and Communications.
- Companies: the subcontractor/vendor directory (and the Insurance dashboard under it).
- Communications: the org-wide log of texts and calls.
- Team: your internal staff members (and their assigned phone numbers).
- Settings: template tags and other workspace configuration.
- My Assignments / My Bids / My POs: focused views for the work assigned to you or, for subs, their own bids and purchase orders.
- Reports, Notifications, Warranty: supporting views.

Access depends on your role: internal staff see everything; homeowners (clients) see only their own project's shared items; subcontractors (trades) see only what they're invited to.`,
  },
  {
    id: "projects",
    title: "Creating & managing projects",
    summary:
      "Starting a job (blank or from the template), project statuses, and the start date.",
    keywords: [
      "project",
      "new job",
      "create project",
      "status",
      "upcoming",
      "in work",
      "inventory",
      "paused",
      "complete",
      "warranty",
      "cancelled",
      "start date",
    ],
    body: `Create a job from Projects → "New project". You can start blank or duplicate the Template job to inherit a full schedule and decisions.

Project statuses mirror the CRM: upcoming, in_work, inventory, paused, complete, warranty, and cancelled. "Open" jobs are upcoming + in_work + inventory + paused. "warranty" is a phase after completion; complete/warranty/cancelled are considered closed.

Start date: a project's start date is the CRM's "Projected Start Date." When you duplicate the template, the whole schedule is anchored on the Job Start milestone so it lands exactly on that start date, and every item shifts together by the same amount. A blank project stamps its Job Start milestone with the start date too. There is no separate "target completion date" field — a job's projected finish comes from the Substantial Completion milestone and the schedule health banner.`,
  },
  {
    id: "templates",
    title: "Smart templates & template tags",
    summary:
      "How the template job copies the right items into a new job using yes/no questions.",
    keywords: [
      "template",
      "smart template",
      "template tags",
      "questionnaire",
      "walkout",
      "either or",
      "tag groups",
      "duplicate",
      "attributes",
    ],
    body: `The Template is a special job whose schedule items and decisions can carry "template tags." When you create or duplicate a job, a short questionnaire asks yes/no questions (e.g. "walkout basement?"). Each item copies into the new job only if its tags match your answers — so a "walkout" item is skipped on a non-walkout home.

Template tags show as purple chips on the schedule list, but only while you're viewing the Template itself — once copied into a real job they're inert and hidden.

Either/or groups: staff can group tags into mutually-exclusive choices in Settings → Template tags (in the avatar menu, staff only). A "required" group shows up as a single-select in the create/duplicate questionnaire and must be answered before you can create the job — picking one option turns that tag on and its siblings off.`,
  },
  {
    id: "schedule",
    title: "Schedule: work items, to-dos & dependencies",
    summary:
      "Work items vs to-dos, nesting, milestones, predecessors, and how dates cascade.",
    keywords: [
      "schedule",
      "work item",
      "todo",
      "to-do",
      "task",
      "milestone",
      "job start",
      "substantial completion",
      "predecessor",
      "dependency",
      "cascade",
      "checklist",
      "priority",
    ],
    body: `The Schedule tab holds two kinds of rows: work items (phases of the job) and to-dos (smaller tasks). A to-do can nest under a work item, or stand alone. To-dos have a checklist; work items don't.

Milestones: every project has two protected milestone work items — Job Start and Substantial Completion. They behave like normal work items (you can move, complete, and link them) but they can never be deleted. Job Start / Substantial Completion anchor the schedule and the health banner.

Predecessors: link items so one follows another (Finish-to-Start is the default). When you move an item, its successors cascade to keep the dependency intact. The system blocks links that would create a circular dependency.

Priority: only "high" priority is shown with a badge; low/medium show no badge (but you can still filter and sort by all three).

Bulk actions: select rows to assign people/roles, copy items to another job, or update several at once from the bulk bar.`,
  },
  {
    id: "baseline-health",
    title: "Schedule baseline & the health banner",
    summary:
      "Setting a baseline, why date changes need a reason after that, and reading the on-track banner.",
    keywords: [
      "baseline",
      "set baseline",
      "health",
      "on track",
      "behind",
      "late",
      "buffer",
      "delay",
      "reason",
      "days remaining",
      "slipping",
    ],
    body: `Baseline: click "Set baseline" on the Schedule tab once the schedule is finalized. This snapshots every work item's current dates as its baseline and marks the job as baselined.

Before a baseline is set, work items can't be marked complete (to-dos can). After the baseline, any date change to a work item asks you for a reason (which is logged as a schedule delay). Work items you add after baselining get their initial dates stamped as their own baseline.

Health banner: at the top of the schedule, the banner compares the current Job Start → Substantial Completion duration against the baseline, with a 30-day buffer. Green ("X Days Remaining in Buffer") means you're within 30 days of the plan; yellow ("X Days Late") means 1–15 days over; red means 16+ over. While Substantial Completion is still incomplete, its projected date is pinned to today, so an untouched, stalled schedule slips one day per day until you update it.

To explain WHY a job is behind, look at the logged delays (each records which item moved, how many days, and the reason category — weather, sub, material, owner decision, permit, or other).`,
  },
  {
    id: "recurring-todos",
    title: "Recurring to-dos",
    summary:
      "How repeating tasks work — they roll forward when you complete them.",
    keywords: [
      "recurring",
      "repeat",
      "recurrence",
      "daily",
      "weekly",
      "biweekly",
      "monthly",
      "roll",
      "series",
    ],
    body: `A to-do can be set to repeat (daily, weekly, biweekly, or monthly, with an optional end date or occurrence count). Recurring to-dos work on a "roll on complete" model: only the current occurrence exists at any time. When you complete it — by any method (checkbox, the detail sheet, bulk, an onsite quick update, or applying an AI plan) — the app automatically creates the next occurrence, advancing the due date past today, resetting the checklist, and copying the assignments.

Nothing is pre-created and nothing is virtual, so your list only ever shows the next real occurrence. A recurrence rule with no due date does nothing — the dialog won't let you save one without a due date.`,
  },
  {
    id: "assignments",
    title: "Assigning work to people, subs & roles",
    summary:
      "Assigning schedule items and to-dos to staff, a company, or a role — and where assignees see them.",
    keywords: [
      "assign",
      "assignment",
      "assignee",
      "role",
      "staff",
      "company",
      "sub",
      "my assignments",
      "who is responsible",
    ],
    body: `Any schedule item (work item or to-do) can be assigned to exactly one of: an internal staff member, a sub/vendor company, or a role. Assign from the item's detail sheet, or select several rows and use the bulk bar to assign (or unassign) a person or role across all of them at once.

Where assignees see their work: internal staff see their assigned items on "My Assignments." Subs assigned to a to-do or a decision selection see them on their own focused views. Assigning a staff member also sends them an in-app notification.`,
  },
  {
    id: "decisions",
    title: "Decisions: change orders & selections",
    summary:
      "The one workflow for change orders and client selections — draft, send, approve, and what happens after.",
    keywords: [
      "decision",
      "change order",
      "selection",
      "client",
      "approve",
      "reject",
      "draft",
      "pending",
      "choices",
      "cost item",
      "follow-up",
      "disclaimer",
      "export",
      "due date",
    ],
    body: `Decisions cover both change orders and client selections on one page (each has a kind and a per-project number). The workflow is: draft → pending client → approved or rejected. Clients can only see a decision once it leaves draft.

Building a decision (staff): while drafting you can add choices, cost line items (staff-only; clients never see costs, and cost items can link to the SpecMagician catalog), assign it to subs, and define follow-up to-do templates. When the decision is approved, those follow-ups automatically become real to-dos on the schedule (with their assignments and notifications). Re-approving is safe — it won't duplicate the follow-ups.

Due dates: a decision's due date can be linked to a schedule item (e.g. "3 days before Framing starts") so it moves automatically when the schedule moves. If a decision is past due, the client can't approve it (they can still decline) and instead sees a "Request due-date reset" button that notifies staff; staff reset it by just editing the due date.

Other tools on the decisions page: an org-wide disclaimer that appears at the bottom of every decision the client views; "Preview as client" to see exactly what the homeowner sees; an Excel export of all decisions; and multi-select "bulk copy" to clone decisions into another job as fresh drafts.

Clients in the project can comment on decisions; subs only see decisions they're assigned to (and never the cost items).`,
  },
  {
    id: "daily-logs",
    title: "Daily logs",
    summary:
      "Internal vs client-visible logs, recording who was on site, photos, and the AI client-update draft.",
    keywords: [
      "daily log",
      "log",
      "internal",
      "client visible",
      "visibility",
      "on site",
      "subs on site",
      "photos",
      "client update",
      "draft update",
    ],
    body: `Daily logs capture what happened on a job each day. Each log has a visibility: "internal" (kept private from the client portal) or "client" (shown to the homeowner) — shown prominently with a colored border and badge. You can record which subs/vendors were on site and attach photos.

Draft client update (AI): on the Daily Logs tab, "Draft client update" gathers the last week of internal logs plus recently-completed and upcoming work and uses AI to rewrite them into a friendly homeowner-facing note. It pre-fills a new log set to "client" visibility — nothing is published until you review and save it.

Clients only ever see logs marked "client"; subcontractors have no access to daily logs.`,
  },
  {
    id: "bids",
    title: "Bid requests",
    summary:
      "Sending bid packages to subs, collecting quotes, and awarding — including the public bid link.",
    keywords: [
      "bid",
      "bid package",
      "bid request",
      "quote",
      "recipient",
      "invite",
      "award",
      "line item",
      "flat fee",
      "my bids",
      "reminder",
    ],
    body: `Bid packages (on a project's Bids tab) collect competitive pricing from subs. A package can be structured as cost-coded line items or a single flat fee, and moves through: draft → sent → awarded or closed.

Each invited company becomes a recipient with its own private link. Subs respond on a public page at /bid/{token} — no login required — or, if they're a trade user, from their own "My Bids" view. They never see competitors' quotes. Sending or reminding respects each company's notification setting.

Revise & re-request: editing a released package isn't silent — it wipes existing quotes and re-invites the non-declined recipients so everyone re-bids on the same terms.

Award: awarding a package can also spin up a draft purchase order pre-filled from the winning quote, linked back to the bid. You can also send a reminder to recipients who were invited but haven't responded yet.`,
  },
  {
    id: "purchase-orders",
    title: "Purchase orders",
    summary:
      "Creating POs, releasing for sub approval, committed costs, and what's out of scope.",
    keywords: [
      "purchase order",
      "po",
      "release",
      "approve",
      "decline",
      "void",
      "signature",
      "committed cost",
      "work complete",
      "my pos",
    ],
    body: `Purchase orders (a project's Purchase Orders tab) commit work to a sub. Each has a number (plus an optional custom number) and moves through: draft → released → approved or declined (and can be voided). Structural edits are only allowed while a PO is still a draft — to change a released PO you unrelease it first.

Releasing a PO emails/texts the sub a public link (/po/{token}). The sub approves it with a typed signature and a disclaimer checkbox, or declines with a reason. Staff can also approve on the sub's behalf. Unreleasing pulls it back to draft and revokes the link; voiding keeps the record but kills the link. "Work complete" is a separate flag from approval.

Committed costs: approved POs roll up by cost code in the Budget tab's POs column, visible only to staff who have financial access — never to clients. Subs see their own non-draft POs on "My POs."

Out of scope (v1): PO payments/bills and lien waivers live in QuickBooks/Adaptive, not here. Client invoicing lives in QuickBooks.`,
  },
  {
    id: "insurance",
    title: "Subcontractor insurance tracking",
    summary:
      "How COIs get in, the coverage dashboard, expiration reminders, and who's required to carry it.",
    keywords: [
      "insurance",
      "coi",
      "certificate",
      "general liability",
      "workers comp",
      "auto",
      "umbrella",
      "expiration",
      "reminder",
      "upload",
      "coverage",
      "w9",
      "sma",
      "master agreement",
      "audit",
      "export",
      "agent",
    ],
    body: `The Insurance dashboard (under Companies → Insurance) tracks each sub's certificates of insurance. It records policies by type — general liability and workers' comp are required; auto and umbrella are tracked. The "current" policy for a company + type is the one with the latest expiration; older ones become history. GL and WC can arrive on two separate certificates with different expiration dates — each coverage type tracks its own dates.

A COI can arrive three ways, all landing in the same review queue: forwarded to a dedicated inbound email address, uploaded by the sub through their private upload link, or uploaded manually by staff. Staff can also drag and drop several files at once anywhere on the Insurance page. Incoming certificates are read by AI to pull out the policy details and auto-match to a company (by sender email, by the insured name matching a company's name or AKA, and by remembering how staff filed past certificates); anything ambiguous lands in the review queue for a staffer to assign — and assigning it once teaches the matcher that spelling for next time.

The page also stores each sub's W9 and Subcontractor Master Agreement (SMA): pick the document type when uploading, and the Docs column shows what's on file. For audits, select multiple companies with the checkboxes and "Download documents" to get one ZIP with each company's current certificates plus latest W9 and SMA.

Only companies marked "Approved for Use" are required to carry insurance — the dashboard focuses on them by default ("Show all statuses" reveals the rest). Expiration reminders email a company (with their upload link) when a current policy is within 7 days of expiring, and CC the sub's insurance agent when one is on file (agent contact lives on the company profile and is auto-filled from the "Producer" on uploaded certificates). Automatic reminders are gated by a global on/off switch and are off until the site goes live, but the manual "Send request" button always works.`,
  },
  {
    id: "companies",
    title: "The subcontractor/vendor directory",
    summary:
      "Managing companies, their trades, contact info, and notification settings.",
    keywords: [
      "company",
      "companies",
      "sub",
      "vendor",
      "directory",
      "trade",
      "phone",
      "notifications",
      "approved for use",
    ],
    body: `Companies is your directory of subs and vendors. Each company has a type, one or more trades, contact details (including a phone number used for texting), a status such as "Approved for Use," and a notifications setting. A company can also carry an "Also Known As" (AKA): the Name field holds the official name used on payments and insurance, while the AKA is the everyday name that may show up on invoices — both are searchable, and insurance matching checks both. The company profile also stores the sub's insurance agent contact, which gets CC'd on certificate requests.

The notifications setting matters: automated messages (bid invites/reminders, PO links, assignment texts, expiration reminders) respect it — a company with notifications off won't be auto-texted. A staffer's explicit "send" click can still override that for one-off sends. Trades and contact info from here feed bidding, purchase orders, insurance, and the AI assistant when it needs to find the right sub to text.`,
  },
  {
    id: "communications",
    title: "Texts, calls & the communications log",
    summary:
      "How outbound/inbound texts and calls are logged, and per-user phone numbers.",
    keywords: [
      "communication",
      "text",
      "sms",
      "call",
      "phone",
      "quo",
      "openphone",
      "number",
      "log",
    ],
    body: `Every outbound and inbound text and call is recorded in the communications log (visible org-wide under Communications, and per-project on a project's Communications tab). Texts are sent through the phone integration; calls are tracked via webhook (the integration can send texts and track calls, but can't place calls for you).

Per-user phone numbers: staff can be assigned their own business number on the Team page. Once assigned, texts you trigger (bid/PO/assignment/manual/AI-applied) go out from your own number automatically — no extra steps. Texts and calls you handle in the phone app also show up in the feed attributed to you. If you have no number assigned, sends fall back to the shared company number.`,
  },
  {
    id: "roles-access",
    title: "Roles & who can see what",
    summary:
      "The difference between staff, clients (homeowners), and trades (subs), and their access.",
    keywords: [
      "role",
      "access",
      "permission",
      "staff",
      "client",
      "homeowner",
      "trade",
      "sub",
      "portal",
      "who can see",
      "financial access",
    ],
    body: `There are three kinds of users:
- Staff (internal): full access to every job and every tab.
- Clients (homeowners): see only their own project, and only the items shared with them — client-visible daily logs, and decisions once they leave draft. They can approve/decline decisions and comment. They never see costs, internal logs, bids, or POs.
- Trades (subs): see only what they're invited to — their own bid packages, their own purchase orders, and decisions/schedule items they're assigned to. They never see competitors' pricing or another job's data.

Within staff, PO/committed-cost dollar amounts are further limited to staff who have "financial access." Access is enforced at the database level, so the rules hold no matter how a page is reached.`,
  },
  {
    id: "history",
    title: "Project history / audit trail",
    summary: "The per-project change log of who changed what and when.",
    keywords: [
      "history",
      "audit",
      "change log",
      "who changed",
      "tracking",
      "activity",
      "restore",
      "recently deleted",
      "undelete",
      "trash",
      "recover",
    ],
    body: `Each project has a History tab (staff only; hidden from clients and trades) that records create/update/delete activity across the schedule, decisions, daily logs, files, payments, bid packages, purchase orders, members, and assignments — with the specific fields that changed. Related changes made together are grouped, so you can see, for example, a bulk schedule shift as one batch. It shows the most recent 500 events.

The History tab also has a "Recently deleted" view: deleted schedule items, decisions, daily logs, files, bid packages and purchase orders are kept for 30 days and can be restored with one click — including their attachments, checklists, choices, line items, comments and assignments. A restored work item brings back its nested to-dos too. After 30 days the entry (and its attachment files) is removed for good. Payments work differently: a deleted payment is restored from the Pricing tab itself, not from Recently deleted.`,
  },
  {
    id: "settings",
    title: "Settings & team configuration",
    summary:
      "Where staff configure template tags, the decision disclaimer, and phone numbers.",
    keywords: [
      "settings",
      "configuration",
      "template tags",
      "disclaimer",
      "team",
      "phone number",
      "admin",
    ],
    body: `Configuration lives in a few staff-only places:
- Settings → Template tags: define the template tags and either/or tag groups used by the create/duplicate questionnaire.
- The Decisions page: an editable box at the top sets the org-wide disclaimer shown to clients at the bottom of every decision.
- Team page: manage internal staff and assign each staffer their own business phone number for outbound texts.
Most other configuration (a company's notification setting, a project's status, a job's baseline) is edited in context on the relevant page rather than in a central settings screen.`,
  },
  {
    id: "ai-assistant",
    title: "Using the AI assistant itself",
    summary:
      "What the AI can do — answer questions, run bulk updates from field notes, and help onsite — and the review-before-apply flow.",
    keywords: [
      "ai",
      "assistant",
      "smart update",
      "agent",
      "help desk",
      "voice",
      "dictate",
      "onsite",
      "walkthrough",
      "plan",
      "apply",
      "field notes",
    ],
    body: `The AI assistant (the "AI" button in the top bar) does three jobs:

1. Help desk — answer questions about how this app works and how to do things (that's what's happening right now). Just ask, e.g. "How do I set a baseline?" or "What's the difference between a change order and a selection?"

2. Reporting — answer questions about your live data: "What's slipping this week?", "Who hasn't bid on the framing package?", "Is the plumber's PO approved?" It reads the data and answers in plain language.

3. Field notes & bulk updates — relay what's happening on site (typed or dictated by voice) and it drafts the actions that follow: schedule updates, new to-dos, assignments, a text to a sub, a bid reminder, a draft change order when the homeowner asks for extra or changed work ("the client wants to add a covered patio" → a draft change order to price), and a daily-log note. It can also make the same change across many jobs at once ("add this checklist item to the framing to-do in every open project").

Nothing happens automatically. For any change, the assistant shows you a plan of exactly what it will do, and you review and approve it before it runs — changes that modify existing data or send a text require you to type "apply" to confirm. On a project page the dialog auto-scopes to that job (shown as a chip you can clear). On the Onsite tab, a voice-memo walkthrough feeds the same assistant and attaches your photos to the daily log automatically.

The assistant can't delete or archive anything, edit bids/POs/companies/files, or show PO dollar amounts.`,
  },
]

// Render the topic catalog for the system prompt — id, title, and one-line
// summary per topic. Small enough to sit in the (cached) prompt so the model
// always knows the full menu of what it can explain and can request the exact
// topic id via search_help_topics.
export function helpCatalog(): string {
  return HELP_TOPICS.map(
    (t) => `- ${t.id} — ${t.title}: ${t.summary}`
  ).join("\n")
}

// Generic question/filler words stripped before ranking so they don't match
// topic titles/keywords. Deliberately excludes domain-ambiguous words like
// "work" (work item), "see" (who can see), and "show".
const QUERY_STOPWORDS = new Set([
  "how", "what", "whats", "where", "when", "why", "who", "whom", "which",
  "can", "could", "should", "would", "does", "did", "the", "and", "for",
  "with", "you", "your", "are", "this", "that", "from", "about", "into",
  "need", "want", "please", "tell", "explain", "using", "use", "app",
])

// Rank/filter topics for the search_help_topics tool. Callers may pass exact
// topic ids (from the catalog) and/or a free-text query. Exact-id requests are
// always returned; the query is matched against id/title/summary/keywords/body
// with light scoring so the most relevant topics come first. Capped so a broad
// query can't dump the whole knowledge base back into the model at once.
export function searchHelpTopics(opts: {
  query?: string | null
  topicIds?: string[] | null
  limit?: number
}): HelpTopic[] {
  const limit = opts.limit ?? 5
  const requested = new Set(
    (opts.topicIds ?? []).map((id) => id.trim().toLowerCase()).filter(Boolean)
  )
  const byId = requested.size
    ? HELP_TOPICS.filter((t) => requested.has(t.id.toLowerCase()))
    : []

  const query = (opts.query ?? "").trim().toLowerCase()
  if (!query) {
    // No query: honor explicit ids, else return the whole set (bounded).
    return (requested.size ? byId : HELP_TOPICS).slice(0, Math.max(limit, byId.length))
  }

  // Tokenize into words 3+ chars, then drop question/filler words that would
  // otherwise match topic titles ("...how it's organized") and skew ranking —
  // "how does a sub submit a bid" should rank on sub/submit/bid, not "how".
  const terms = query
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !QUERY_STOPWORDS.has(w))
  const scored = HELP_TOPICS.filter((t) => !requested.has(t.id.toLowerCase()))
    .map((t) => {
      const haystackStrong = `${t.id} ${t.title} ${t.summary} ${t.keywords.join(" ")}`.toLowerCase()
      const haystackBody = t.body.toLowerCase()
      let score = 0
      // Weight matches in the id/title/summary/keywords far above matches in
      // the body prose: a topic ABOUT the subject beats one that merely
      // mentions it (several topics quote example questions in their body —
      // e.g. the ai-assistant topic lists "how do I set a baseline?" — which
      // must not outrank the baseline topic itself).
      if (haystackStrong.includes(query)) score += 12
      else if (haystackBody.includes(query)) score += 2
      for (const term of terms) {
        if (haystackStrong.includes(term)) score += 4
        else if (haystackBody.includes(term)) score += 1
      }
      return { topic: t, score }
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((s) => s.topic)

  // Explicit ids first, then best query matches, deduped, capped.
  const ordered = [...byId, ...scored]
  return ordered.slice(0, Math.max(limit, byId.length))
}

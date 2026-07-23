// The What's New feed (staff-only page at /whats-new). NEWEST FIRST.
//
// Convention: every user-visible feature, improvement, or fix that ships
// should add one SHORT entry here in the same PR — a single plain-English
// sentence; users can always ask for more detail. Internal refactors with no
// visible behavior change don't need an entry.

export type WhatsNewKind = "feature" | "improvement" | "fix"

export type WhatsNewEntry = {
  // Calendar date the change shipped (YYYY-MM-DD).
  date: string
  title: string
  kind: WhatsNewKind
}

export const WHATS_NEW: WhatsNewEntry[] = [
  {
    date: "2026-07-23",
    title:
      "Organizations can now connect their own OpenPhone account (Settings → Organization → Integrations, under Advanced) to text and call from a full phone app — it takes over from the built-in texting number automatically, and adding the webhook signing secret mirrors replies and calls into the Communications feed.",
    kind: "feature",
  },
  {
    date: "2026-07-23",
    title:
      "Platform: feature access levels — define what each subscription level includes and assign organizations to levels (avatar menu → Feature access, platform owner only).",
    kind: "feature",
  },
  {
    date: "2026-07-23",
    title:
      "Synced Outlook emails now file to a job only when AI confidently matches the email's content to that job — everything else stays in the global Communications hub.",
    kind: "improvement",
  },
  {
    date: "2026-07-23",
    title:
      "You can now add a job log straight from the all-jobs Job Logs view — a picker asks which job it belongs to (any job, including Complete and Warranty), then the usual editor opens.",
    kind: "feature",
  },
  {
    date: "2026-07-23",
    title:
      "Fixed large-file uploads: files over 6 MB (plans, videos) failed with an authorization error — they upload normally now.",
    kind: "fix",
  },
  {
    date: "2026-07-23",
    title:
      "Assignment notifications now appear in the recipient's in-app bell (previously only the email went out).",
    kind: "fix",
  },
  {
    date: "2026-07-23",
    title:
      "Fixed decision follow-up tasks not showing in the decision drawer on the Decisions page.",
    kind: "fix",
  },
  {
    date: "2026-07-23",
    title:
      "Approved selections and change orders can no longer be deleted (or their approved choice removed) without resetting the approval first.",
    kind: "improvement",
  },
  {
    date: "2026-07-23",
    title:
      "Mute notifications per job — the bell on a job's header or Settings → Notifications turns off that job's alerts just for you.",
    kind: "feature",
  },
  {
    date: "2026-07-23",
    title:
      "Selection-approval emails now show only the approved choice (and its photos), and notifications about a job only go to that organization's own team.",
    kind: "fix",
  },
  {
    date: "2026-07-23",
    title:
      "Initiate Utilities: each request now shows the date it was submitted, and a search box filters requests by job, address, or status.",
    kind: "improvement",
  },
  {
    date: "2026-07-23",
    title:
      "Fixed: the Gantt chart crashed phone browsers on long schedules — it now loads on mobile.",
    kind: "fix",
  },
  {
    date: "2026-07-23",
    title: "What's New — this page. Every update lands here, newest first.",
    kind: "feature",
  },
  {
    date: "2026-07-23",
    title:
      "Dropdowns for people, companies, jobs and cost codes are searchable — start typing to filter.",
    kind: "feature",
  },
  {
    date: "2026-07-23",
    title:
      "Bid Request and Purchase Order Scope fields have a formatting toolbar (bullets, numbering, bold) — formatting shows on the sub's page.",
    kind: "feature",
  },
  {
    date: "2026-07-23",
    title:
      "Selections: the approved choice now moves to the top of the list with a green highlight.",
    kind: "improvement",
  },
  {
    date: "2026-07-23",
    title: "Selections: click any photo to view it full-screen.",
    kind: "feature",
  },
  {
    date: "2026-07-23",
    title:
      "Late work items and to-dos now show in red across the schedule, To-Dos, Gantt, and My Assignments.",
    kind: "feature",
  },
  {
    date: "2026-07-23",
    title:
      "Filtering to-dos by a person now includes items assigned to a role they fill on the job.",
    kind: "improvement",
  },
  {
    date: "2026-07-20",
    title: "New trial accounts start with a sample demo project.",
    kind: "feature",
  },
  {
    date: "2026-07-20",
    title:
      "Fixed: trial builders (non-Hines staff) were bounced back to the login page.",
    kind: "fix",
  },
  {
    date: "2026-07-20",
    title: "Fixed: trial-signup CAPTCHA rejected every legitimate signup.",
    kind: "fix",
  },
  {
    date: "2026-07-20",
    title:
      "Builder emails send from one shared address with replies routed back to the right company.",
    kind: "improvement",
  },
  {
    date: "2026-07-19",
    title:
      "Built-in texting for builder accounts — a dedicated number, no API key needed.",
    kind: "feature",
  },
  {
    date: "2026-07-19",
    title: "Built-in email sending for builder accounts (no setup).",
    kind: "feature",
  },
  {
    date: "2026-07-19",
    title:
      "Stripe billing: expired trials see a paywall and can subscribe to keep going; billing is managed in the Stripe portal.",
    kind: "feature",
  },
  {
    date: "2026-07-19",
    title:
      "Self-serve trials: sales-site signups create a 7-day sandbox; expired sandboxes are cleaned up after a 30-day grace.",
    kind: "feature",
  },
  {
    date: "2026-07-19",
    title:
      "New \"Provision organization\" screen for standing up a builder account.",
    kind: "feature",
  },
  {
    date: "2026-07-19",
    title:
      "Each organization connects its own QuickBooks, phone, and email — nothing is shared with Hines Homes.",
    kind: "improvement",
  },
  {
    date: "2026-07-18",
    title:
      "Multi-tenant foundation: organizations, members, per-org data and branding.",
    kind: "feature",
  },
  {
    date: "2026-07-18",
    title:
      "Product renamed BuildFox; the Onsite tab is now OnsiteIQ.",
    kind: "improvement",
  },
  {
    date: "2026-07-18",
    title:
      "Duplicating a project now copies its purchase orders and bid requests as fresh drafts.",
    kind: "feature",
  },
]

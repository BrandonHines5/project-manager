#!/usr/bin/env node
// Bridge-default guard (multi-tenancy, Stage B6).
//
// Stage B1 (migration 0099) added `org_id NOT NULL DEFAULT <hines>` to eleven
// ROOT tables as a *bridge*: a temporary default so existing single-tenant
// insert paths kept working before every call site learned to stamp org_id
// explicitly. As each module became org-aware, its bridge default was dropped
// so a forgotten stamp fails loudly (23502) instead of silently filing a new
// org's row under Hines. A bridge default that outlives its module is a
// silent cross-tenant data leak — the exact failure this whole build exists to
// prevent.
//
// This guard replays the DEFAULT set/drop history across the numbered
// migrations and asserts the set of tables STILL carrying the Hines bridge
// default is exactly the allowlist below. It runs in CI on any migration
// change (see .github/workflows/bridge-default-guard.yml) and needs no
// database — it reads the migration SQL as the source of truth.
//
// When you legitimately drop the last remaining default (communications, once
// inbound phone traffic is org-resolvable), remove it from ALLOWLIST in the
// same PR — the guard fails on a stale allowlist too, so it can't rot.

import { readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const HINES_ORG_ID = "018f6f2a-4c1e-4b8e-9d3a-7c5b2e8a1f10"

// Tables intentionally still carrying the Hines bridge default, each with the
// reason it can't be dropped yet. Keep this list — and the reasons — honest.
const ALLOWLIST = new Map([
  [
    "communications",
    "inbound phone/SMS has no org signal until per-org OpenPhone " +
      "workspaces (per-org webhook secrets/endpoints) exist — infra, not code.",
  ],
])

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "supabase",
  "migrations"
)

/** Strip `-- …` line comments so comment prose can't match our SQL patterns. */
function stripLineComments(sql) {
  return sql.replace(/--[^\n]*/g, "")
}

// A bridge default is SET when an org_id column is given the Hines UUID as its
// default, in either the add-column form (0099, 0102) or a set-default form.
// It's DROPPED by `alter column org_id drop default`. We split each file into
// `;`-terminated statements and match per statement so an add-column's default
// can't be associated with the wrong table. Function-parameter defaults
// (0111's `p_seed_from uuid default '<hines>'`) never mention org_id or
// `alter table`, so they can't match.
const SET_ADD_COLUMN = new RegExp(
  `alter\\s+table\\s+(\\w+)\\b[\\s\\S]*\\badd\\s+column\\b[\\s\\S]*\\borg_id\\b[\\s\\S]*\\bdefault\\s+'${HINES_ORG_ID}'`,
  "i"
)
const SET_ALTER_COLUMN = new RegExp(
  `alter\\s+table\\s+(\\w+)\\s+alter\\s+column\\s+org_id\\s+set\\s+default\\s+'${HINES_ORG_ID}'`,
  "i"
)
const DROP_DEFAULT = /alter\s+table\s+(\w+)\s+alter\s+column\s+org_id\s+drop\s+default/i

function migrationFiles() {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort() // zero-padded numeric prefixes sort chronologically
}

/** Replay every migration; return { table -> firstMigrationThatSetIt }. */
function computeActiveDefaults() {
  const active = new Map()
  for (const file of migrationFiles()) {
    const sql = stripLineComments(readFileSync(join(MIGRATIONS_DIR, file), "utf8"))
    for (const stmt of sql.split(";")) {
      const s = stmt.trim()
      if (!s) continue
      const setMatch = s.match(SET_ADD_COLUMN) || s.match(SET_ALTER_COLUMN)
      if (setMatch) {
        const table = setMatch[1].toLowerCase()
        if (!active.has(table)) active.set(table, file)
        continue
      }
      const dropMatch = s.match(DROP_DEFAULT)
      if (dropMatch) active.delete(dropMatch[1].toLowerCase())
    }
  }
  return active
}

function main() {
  const active = computeActiveDefaults()
  const activeTables = [...active.keys()].sort()

  // Undropped: a table carries the bridge default but isn't allowlisted.
  const undropped = activeTables.filter((t) => !ALLOWLIST.has(t))
  // Stale allowlist: an allowlisted table no longer carries the default.
  const stale = [...ALLOWLIST.keys()].filter((t) => !active.has(t)).sort()

  const problems = []
  if (undropped.length) {
    problems.push(
      "Tables carrying the Hines bridge default that are NOT allowlisted:\n" +
        undropped
          .map((t) => `  • ${t}  (default set in ${active.get(t)})`)
          .join("\n") +
        "\n\nEither the module is org-aware — drop the default in this " +
        "migration:\n    alter table <t> alter column org_id drop default;\n" +
        "and stamp org_id explicitly at every insert site — or, if it's a " +
        "deliberate temporary bridge, add it to ALLOWLIST in " +
        "scripts/check-bridge-defaults.mjs with the reason."
    )
  }
  if (stale.length) {
    problems.push(
      "Allowlisted tables whose bridge default was already dropped " +
        "(remove them from ALLOWLIST):\n" +
        stale.map((t) => `  • ${t}`).join("\n")
    )
  }

  if (problems.length) {
    console.error("✗ Bridge-default guard failed.\n")
    console.error(problems.join("\n\n"))
    process.exit(1)
  }

  console.log("✓ Bridge-default guard passed.")
  if (activeTables.length) {
    console.log(
      "\nRemaining bridge defaults (all allowlisted, intentional):\n" +
        activeTables
          .map((t) => `  • ${t} — ${ALLOWLIST.get(t)}`)
          .join("\n")
    )
  } else {
    console.log("No bridge defaults remain — every stamped table is org-strict.")
  }
}

main()

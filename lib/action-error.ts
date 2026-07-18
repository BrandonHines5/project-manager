import { toast } from "sonner"
import { userErrorMessageFromDigest } from "@/lib/user-error"

// Every deploy rebuilds the app and rotates the ids Next.js assigns to server
// actions. A browser tab loaded before the deploy keeps calling the old ids,
// and every action call from it fails with the raw Next.js error ("Server
// Action "…" was not found on the server"). Nothing is wrong with the user's
// input — the tab just needs a refresh. The wording has varied across Next.js
// versions, so match both known phrasings.
const STALE_ACTION_PATTERN =
  /server action .*(was not found|could not be found)|failed to find server action/i

export function isStaleDeploymentError(e: unknown): boolean {
  return e instanceof Error && STALE_ACTION_PATTERN.test(e.message)
}

export const STALE_DEPLOYMENT_MESSAGE =
  "The app has been updated since this page was loaded. Refresh the page and try again."

// Production builds mask the message of every error thrown in a server action
// — the browser gets React's "Server Components render" boilerplate instead.
// Deliberate user-facing messages survive by riding the digest (see
// lib/user-error.ts); anything else that arrives masked is an internal
// failure whose details the user was never meant to see, so show the catch
// site's fallback rather than the React internals paragraph.
const MASKED_PRODUCTION_PATTERN =
  /an error occurred in the server components render/i

// For catch sites that surface the message somewhere other than a toast
// (inline error text, chat bubbles): the refresh prompt for stale-deployment
// failures, the digest-carried message for deliberate user-facing errors, the
// error's own message otherwise, the fallback for non-Errors and for masked
// production errors.
export function actionErrorMessage(e: unknown, fallback: string): string {
  if (isStaleDeploymentError(e)) return STALE_DEPLOYMENT_MESSAGE
  const userFacing = userErrorMessageFromDigest(e)
  if (userFacing) return userFacing
  if (e instanceof Error && MASKED_PRODUCTION_PATTERN.test(e.message)) {
    return fallback
  }
  return e instanceof Error ? e.message : fallback
}

// Drop-in replacement for the
// `toast.error(e instanceof Error ? e.message : "Save failed")`
// catch pattern. Stale-deployment failures get the refresh prompt with a
// one-click Refresh button (sticks around longer than a normal toast so the
// user can read it); everything else surfaces exactly as before.
export function toastActionError(e: unknown, fallback: string): void {
  if (isStaleDeploymentError(e)) {
    toast.error(STALE_DEPLOYMENT_MESSAGE, {
      duration: 10000,
      action: {
        label: "Refresh",
        onClick: () => window.location.reload(),
      },
    })
    return
  }
  toast.error(actionErrorMessage(e, fallback))
}

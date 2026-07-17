import { toast } from "sonner"

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

// For catch sites that surface the message somewhere other than a toast
// (inline error text, chat bubbles): the refresh prompt for stale-deployment
// failures, the error's own message otherwise, the fallback for non-Errors.
export function actionErrorMessage(e: unknown, fallback: string): string {
  if (isStaleDeploymentError(e)) return STALE_DEPLOYMENT_MESSAGE
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
  toast.error(e instanceof Error ? e.message : fallback)
}

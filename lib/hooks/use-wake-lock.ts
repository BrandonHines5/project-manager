import { useEffect } from "react"

/**
 * Hold a screen wake lock while `active` is true. iPhones auto-lock after
 * ~30s idle, and iOS Safari kills in-flight fetches when the screen locks —
 * fatal for a long AI turn submitted from the jobsite ("Load failed").
 * Feature-detected: silently a no-op on browsers without the Wake Lock API
 * (iOS Safari < 16.4, Firefox).
 */
export function useScreenWakeLock(active: boolean) {
  useEffect(() => {
    if (!active || typeof navigator === "undefined" || !navigator.wakeLock) {
      return
    }
    let sentinel: WakeLockSentinel | null = null
    let cancelled = false
    const acquire = async () => {
      try {
        const s = await navigator.wakeLock.request("screen")
        if (cancelled) {
          s.release().catch(() => {})
        } else {
          sentinel = s
        }
      } catch {
        // Request denied (low battery mode, etc.) — we just lose the
        // keep-awake nicety, nothing to surface.
      }
    }
    // The browser auto-releases the lock when the tab is hidden; re-acquire
    // when the user comes back while the work is still running.
    const onVisibility = () => {
      if (document.visibilityState === "visible") void acquire()
    }
    void acquire()
    document.addEventListener("visibilitychange", onVisibility)
    return () => {
      cancelled = true
      document.removeEventListener("visibilitychange", onVisibility)
      sentinel?.release().catch(() => {})
    }
  }, [active])
}

"use client"

import { useCallback, useEffect, useState } from "react"

const EARTH_RADIUS_M = 6_371_000
const CACHE_TTL_MS = 10 * 60 * 1000

export type OnsiteState =
  | "idle"
  | "requesting"
  | "denied"
  | "unavailable"
  | "offsite"
  | "onsite"

export type UseOnsiteResult = {
  state: OnsiteState
  distanceMeters: number | null
  errorMessage: string | null
  retry: () => void
}

type CachedFix = {
  lat: number
  lng: number
  distanceMeters: number
  state: "onsite" | "offsite"
  capturedAt: number
}

function haversineMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a))
}

// 6-decimal precision (~11cm) makes the cache key stable across float
// round-trips while still invalidating any meaningful coordinate change.
function cacheKey(projectId: string, lat: number, lng: number) {
  return `onsite:${projectId}:${lat.toFixed(6)}:${lng.toFixed(6)}`
}

function readCache(
  projectId: string,
  lat: number,
  lng: number
): CachedFix | null {
  if (typeof window === "undefined") return null
  try {
    const raw = window.sessionStorage.getItem(cacheKey(projectId, lat, lng))
    if (!raw) return null
    const parsed = JSON.parse(raw) as CachedFix
    if (Date.now() - parsed.capturedAt > CACHE_TTL_MS) return null
    return parsed
  } catch {
    return null
  }
}

function writeCache(
  projectId: string,
  lat: number,
  lng: number,
  fix: CachedFix
) {
  if (typeof window === "undefined") return
  try {
    window.sessionStorage.setItem(
      cacheKey(projectId, lat, lng),
      JSON.stringify(fix)
    )
  } catch {
    // Quota errors etc. — caching is best-effort, never fatal.
  }
}

/**
 * Checks once per visit whether the user is within `radiusMeters` of the
 * project coordinates. Result is cached in sessionStorage for 10 minutes so
 * a soft reload doesn't re-prompt for permission.
 */
export function useOnsite({
  projectId,
  lat,
  lng,
  radiusMeters = 200,
}: {
  projectId: string
  lat: number
  lng: number
  radiusMeters?: number
}): UseOnsiteResult {
  const [state, setState] = useState<OnsiteState>("idle")
  const [distanceMeters, setDistanceMeters] = useState<number | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  const retry = useCallback(() => {
    if (typeof window !== "undefined") {
      window.sessionStorage.removeItem(cacheKey(projectId, lat, lng))
    }
    setErrorMessage(null)
    setDistanceMeters(null)
    setState("idle")
    setTick((t) => t + 1)
  }, [projectId, lat, lng])

  useEffect(() => {
    if (typeof window === "undefined") return
    if (!("geolocation" in navigator)) {
      // Run on next tick so the lint rule (no synchronous setState in effect
      // bodies) is satisfied. The unavailability is permanent for this
      // session — a microtask delay is invisible.
      const id = window.setTimeout(() => {
        setState("unavailable")
        setErrorMessage("This browser doesn't support geolocation.")
      }, 0)
      return () => window.clearTimeout(id)
    }

    const cached = readCache(projectId, lat, lng)
    if (cached) {
      const id = window.setTimeout(() => {
        setDistanceMeters(cached.distanceMeters)
        setState(cached.state)
      }, 0)
      return () => window.clearTimeout(id)
    }

    const requestId = window.setTimeout(() => setState("requesting"), 0)
    let cancelled = false
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (cancelled) return
        const d = haversineMeters(
          pos.coords.latitude,
          pos.coords.longitude,
          lat,
          lng
        )
        const next: "onsite" | "offsite" = d <= radiusMeters ? "onsite" : "offsite"
        setDistanceMeters(d)
        setState(next)
        writeCache(projectId, lat, lng, {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          distanceMeters: d,
          state: next,
          capturedAt: Date.now(),
        })
      },
      (err) => {
        if (cancelled) return
        if (err.code === err.PERMISSION_DENIED) {
          setState("denied")
          setErrorMessage("Location permission was denied.")
        } else {
          setState("unavailable")
          setErrorMessage(
            err.code === err.TIMEOUT
              ? "Couldn't get a location fix in time."
              : "Couldn't determine your location."
          )
        }
      },
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 }
    )

    return () => {
      cancelled = true
      window.clearTimeout(requestId)
    }
  }, [projectId, lat, lng, radiusMeters, tick])

  return { state, distanceMeters, errorMessage, retry }
}

"use client"

// Resilient browser → Supabase Storage uploads for jobsites with bad signal.
//
// Two paths, one entry point (`uploadToStorage`):
//   * Small files: the normal storage-js single-shot upload, wrapped in a
//     bounded retry with backoff. A retry AFTER a request that actually
//     landed (response lost on flaky LTE) comes back 409 "already exists" —
//     that is SUCCESS here (same path, same bytes), never a failure.
//   * Large files (> 6 MB — think jobsite videos): the TUS resumable
//     protocol via tus-js-client against /storage/v1/upload/resumable.
//     Chunks are 6 MB (the size Supabase requires), each chunk retries with
//     backoff, and a dropped connection resumes mid-file instead of
//     restarting — which is what makes big videos survive weak signal.
//
// The same storage RLS that governs .upload() governs TUS writes, so no
// policy changes; auth rides the user's JWT (refreshed per request for
// uploads that outlive the ~1h access token).

import * as tus from "tus-js-client"
import type { SupabaseClient } from "@supabase/supabase-js"
import type { Database } from "@/lib/db/types"

const TUS_THRESHOLD_BYTES = 6 * 1024 * 1024
// Supabase's resumable endpoint requires exactly 6 MB chunks.
const TUS_CHUNK_BYTES = 6 * 1024 * 1024
const RETRY_DELAYS_MS = [1_000, 3_000, 8_000]

// Mirror of the Supabase project's global upload limit (Dashboard → Project
// Settings → Storage). Known client-side so oversized files are refused
// BEFORE any bytes go out — pushing 200+ MB over jobsite LTE just to get a
// 413 wastes minutes and battery. If the dashboard value changes, update
// NEXT_PUBLIC_MAX_UPLOAD_MB in Vercel (or this default). The server still
// enforces its own limit either way; drift here only changes which error
// message the user sees.
const MAX_UPLOAD_MB =
  Number(process.env.NEXT_PUBLIC_MAX_UPLOAD_MB) > 0
    ? Number(process.env.NEXT_PUBLIC_MAX_UPLOAD_MB)
    : 200
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024

// Field-usable guidance, not "ask an admin": what the person standing on
// site can actually do about an oversized file right now.
function oversizeMessage(sizeBytes: number | null, contentType?: string): string {
  const lead =
    sizeBytes != null
      ? `This file is ${Math.round(sizeBytes / (1024 * 1024))} MB — over the ${MAX_UPLOAD_MB} MB upload limit.`
      : `This file is over the ${MAX_UPLOAD_MB} MB upload limit.`
  const tip = contentType?.startsWith("video/")
    ? " Trim it in the Photos app, split it into shorter clips, or record at 1080p instead of 4K."
    : " Compress it or split it into smaller files."
  return lead + tip
}

export type StorageUploadResult =
  | { ok: true }
  | { ok: false; error: string; retriable: boolean }

export type StorageUploadOpts = {
  bucket: string
  path: string
  body: Blob
  contentType?: string
  cacheControl?: string
  /** 0..1, TUS path only (single-shot uploads have no progress events). */
  onProgress?: (fraction: number) => void
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function statusOf(err: unknown): number | null {
  const raw =
    (err as { statusCode?: unknown; status?: unknown })?.statusCode ??
    (err as { status?: unknown })?.status
  const n = typeof raw === "string" ? Number(raw) : raw
  return typeof n === "number" && Number.isFinite(n) ? n : null
}

// 413 = the server's own limit said no (e.g. the constant above is out of
// date) — same guidance, size taken from what we tried to send.
function friendlyMessage(
  status: number | null,
  fallback: string,
  opts: StorageUploadOpts
): string {
  if (status === 413) {
    return oversizeMessage(opts.body.size, opts.contentType)
  }
  return fallback
}

export async function uploadToStorage(
  supabase: SupabaseClient<Database>,
  opts: StorageUploadOpts
): Promise<StorageUploadResult> {
  // Pre-flight: refuse oversized files instantly with actionable guidance
  // instead of uploading for minutes and failing with a server 413.
  if (opts.body.size > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      error: oversizeMessage(opts.body.size, opts.contentType),
      retriable: false,
    }
  }
  if (opts.body.size > TUS_THRESHOLD_BYTES) {
    return uploadResumable(supabase, opts)
  }

  let lastError = "Upload failed"
  for (let attempt = 0; ; attempt++) {
    try {
      const { error } = await supabase.storage
        .from(opts.bucket)
        .upload(opts.path, opts.body, {
          cacheControl: opts.cacheControl ?? "3600",
          upsert: false,
          contentType: opts.contentType || undefined,
        })
      if (!error) return { ok: true }
      const status = statusOf(error)
      // 409 = the object already exists at this path. Paths are random per
      // pick, so the only way that happens is a previous attempt that
      // succeeded server-side — treat as done.
      if (status === 409 || /already exists/i.test(error.message)) {
        return { ok: true }
      }
      // Hard client errors never fix themselves — surface immediately.
      if (status != null && status >= 400 && status < 500 && status !== 408 && status !== 429) {
        return {
          ok: false,
          error: friendlyMessage(status, error.message, opts),
          retriable: false,
        }
      }
      lastError = error.message
    } catch (e) {
      // fetch TypeError etc. — the network-drop case retries exist for.
      lastError = e instanceof Error ? e.message : String(e)
    }
    if (attempt >= RETRY_DELAYS_MS.length) {
      return { ok: false, error: lastError, retriable: true }
    }
    await sleep(RETRY_DELAYS_MS[attempt] + Math.random() * 500)
  }
}

async function uploadResumable(
  supabase: SupabaseClient<Database>,
  opts: StorageUploadOpts
): Promise<StorageUploadResult> {
  const {
    data: { session },
  } = await supabase.auth.getSession()
  if (!session) {
    return { ok: false, error: "Not signed in", retriable: false }
  }
  return new Promise((resolve) => {
    const upload = new tus.Upload(opts.body, {
      endpoint: `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/upload/resumable`,
      chunkSize: TUS_CHUNK_BYTES,
      retryDelays: [0, 3_000, 5_000, 10_000, 20_000],
      headers: {
        authorization: `Bearer ${session.access_token}`,
        apikey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
        "x-upsert": "false",
      },
      metadata: {
        bucketName: opts.bucket,
        objectName: opts.path,
        contentType: opts.contentType || "application/octet-stream",
        cacheControl: opts.cacheControl ?? "3600",
      },
      uploadDataDuringCreation: true,
      removeFingerprintOnSuccess: true,
      // A long video on jobsite LTE can outlive the ~1h access token —
      // re-read the session before each request so later chunks don't 401.
      onBeforeRequest: async (req) => {
        const {
          data: { session: fresh },
        } = await supabase.auth.getSession()
        if (fresh) {
          req.setHeader("authorization", `Bearer ${fresh.access_token}`)
        }
      },
      onProgress: (sent, total) => {
        if (total > 0) opts.onProgress?.(sent / total)
      },
      onError: (err) => {
        const status = statusOf(
          (err as tus.DetailedError).originalResponse?.getStatus?.() != null
            ? { status: (err as tus.DetailedError).originalResponse?.getStatus() }
            : err
        )
        // Unlike the single-shot path, a TUS 409 is an offset conflict, not
        // proof the object landed — tus retries those internally, so one that
        // still reaches onError is a real failure. Only onSuccess reports ok.
        resolve({
          ok: false,
          error: friendlyMessage(status, err.message, opts),
          // tus already retried transient failures internally; what reaches
          // here is worth a manual retry only for network-ish causes.
          retriable:
            status == null ||
            status >= 500 ||
            status === 408 ||
            status === 429 ||
            status === 409,
        })
      },
      onSuccess: () => resolve({ ok: true }),
    })
    // Resume a previous attempt when one exists — but only one that targets
    // THIS bucket+path. The fingerprint is file-based, so a re-pick of the
    // same file under a freshly generated path would otherwise resume the old
    // upload and finish at the OLD objectName while the caller records the
    // new one.
    upload
      .findPreviousUploads()
      .then((previous) => {
        const match = previous.find(
          (p) =>
            p.metadata?.bucketName === opts.bucket &&
            p.metadata?.objectName === opts.path
        )
        if (match) upload.resumeFromPreviousUpload(match)
        upload.start()
      })
      .catch(() => upload.start())
  })
}

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

function friendlyMessage(status: number | null, fallback: string): string {
  if (status === 413) {
    return "File exceeds the upload size limit — ask an admin to raise it in Supabase Storage settings"
  }
  return fallback
}

export async function uploadToStorage(
  supabase: SupabaseClient<Database>,
  opts: StorageUploadOpts
): Promise<StorageUploadResult> {
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
          error: friendlyMessage(status, error.message),
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
        if (status === 409) {
          resolve({ ok: true })
          return
        }
        resolve({
          ok: false,
          error: friendlyMessage(status, err.message),
          // tus already retried transient failures internally; what reaches
          // here is worth a manual retry only for network-ish causes.
          retriable: status == null || status >= 500 || status === 408 || status === 429,
        })
      },
      onSuccess: () => resolve({ ok: true }),
    })
    // Resume a previous attempt at the same fingerprint when one exists.
    upload
      .findPreviousUploads()
      .then((previous) => {
        if (previous.length > 0) upload.resumeFromPreviousUpload(previous[0])
        upload.start()
      })
      .catch(() => upload.start())
  })
}

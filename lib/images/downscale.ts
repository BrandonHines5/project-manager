// Browser-only: shrink a photo before upload. Jobsite phone photos are
// 3-8 MB; at 1600px they're a few hundred KB, which matters on LTE and is
// plenty for a daily-log record. Re-encoding to JPEG also normalizes iPhone
// HEIC whenever the browser can decode it.

export async function downscalePhoto(
  file: File,
  maxDim = 1600,
  quality = 0.8
): Promise<{ blob: Blob; fileType: string }> {
  try {
    const bitmap = await decodeImage(file)
    try {
      const srcW =
        bitmap instanceof HTMLImageElement ? bitmap.naturalWidth : bitmap.width
      const srcH =
        bitmap instanceof HTMLImageElement ? bitmap.naturalHeight : bitmap.height
      if (!srcW || !srcH) throw new Error("empty image")
      const scale = Math.min(1, maxDim / Math.max(srcW, srcH))
      const width = Math.max(1, Math.round(srcW * scale))
      const height = Math.max(1, Math.round(srcH * scale))
      const canvas = document.createElement("canvas")
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext("2d")
      if (!ctx) throw new Error("no 2d context")
      ctx.drawImage(bitmap, 0, 0, width, height)
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/jpeg", quality)
      )
      if (!blob) throw new Error("toBlob failed")
      return { blob, fileType: "image/jpeg" }
    } finally {
      if ("close" in bitmap) bitmap.close()
    }
  } catch {
    // An un-downscaled upload beats a lost photo — fall back to the
    // original bytes on any decode/encode failure.
    return { blob: file, fileType: file.type || "application/octet-stream" }
  }
}

async function decodeImage(
  file: File
): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file)
    } catch {
      // Fall through to the <img> path — some browsers can decode via an
      // element what createImageBitmap rejects.
    }
  }
  const url = URL.createObjectURL(file)
  try {
    const img = new Image()
    img.decoding = "async"
    img.src = url
    await img.decode()
    return img
  } finally {
    URL.revokeObjectURL(url)
  }
}

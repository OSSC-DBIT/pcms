/**
 * Phone cameras produce 4 to 12 MB photos (and HEIC on iPhone), which the server
 * limit of 5 MB would reject. Photos are therefore decoded and re-saved as JPEG
 * at most 2048 px on the long side before upload. This also removes location
 * metadata on the device; the server strips it again regardless.
 */
import type { TKey } from './i18n'

export const MAX_VIDEO_BYTES = 20 * 1024 * 1024
export const MAX_VIDEO_SECONDS = 30
// The server turns iPhone .MOV (H.264) into MP4.
export const VIDEO_TYPES = ['video/mp4', 'video/webm', 'video/quicktime']
const MAX_EDGE = 2048

/** A problem found on the device before upload. `key` is the message to show, in the reader's language. */
export class PrepareError extends Error {
  readonly key: TKey
  constructor(key: TKey) {
    super(key)
    this.key = key
  }
}

export async function preparePhoto(file: File): Promise<File> {
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch {
    throw new PrepareError('media.photoUnreadable')
  }
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height))
  const w = Math.max(1, Math.round(bitmap.width * scale))
  const h = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new PrepareError('media.photoUnsupported')
  ctx.drawImage(bitmap, 0, 0, w, h)
  bitmap.close()
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85))
  if (!blob) throw new PrepareError('media.photoFailed')
  const base = file.name.replace(/\.[^.]+$/, '') || 'photo'
  return new File([blob], `${base}.jpg`, { type: 'image/jpeg', lastModified: Date.now() })
}

/** The message key for a video the server would refuse, or null if it can be uploaded. */
export function checkVideo(file: File): TKey | null {
  if (!VIDEO_TYPES.includes(file.type)) return 'media.videoFormat'
  if (file.size > MAX_VIDEO_BYTES) return 'media.videoTooLarge'
  return null
}

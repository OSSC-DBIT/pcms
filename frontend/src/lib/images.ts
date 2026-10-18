/**
 * Phone cameras produce 4 to 12 MB photos (and HEIC on iPhone), which the server
 * limit of 5 MB would reject. Photos are therefore decoded and re-saved as JPEG
 * at most 2048 px on the long side before upload. This also removes location
 * metadata on the device; the server strips it again regardless.
 */
export const MAX_VIDEO_BYTES = 20 * 1024 * 1024
export const VIDEO_TYPES = ['video/mp4', 'video/webm']
const MAX_EDGE = 2048

export class PrepareError extends Error {}

export async function preparePhoto(file: File): Promise<File> {
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch {
    throw new PrepareError('This photo could not be read. Take it again or choose a JPEG or PNG.')
  }
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height))
  const w = Math.max(1, Math.round(bitmap.width * scale))
  const h = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new PrepareError('This device cannot process photos.')
  ctx.drawImage(bitmap, 0, 0, w, h)
  bitmap.close()
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85))
  if (!blob) throw new PrepareError('This photo could not be processed.')
  const base = file.name.replace(/\.[^.]+$/, '') || 'photo'
  return new File([blob], `${base}.jpg`, { type: 'image/jpeg', lastModified: Date.now() })
}

export function checkVideo(file: File): string | null {
  if (!VIDEO_TYPES.includes(file.type)) return 'Use an MP4 video (on iPhone: Settings, Camera, Formats, Most Compatible).'
  if (file.size > MAX_VIDEO_BYTES) return 'Videos can be at most 20 MB (about 30 seconds).'
  return null
}

/** Shared helpers for typed-text translation (facility manager only; the server enforces it). */
import { api } from './api'
import type { Lang } from './i18n'

/** The script tells the language: Kannada letters, Devanagari (Hindi), otherwise English. */
export function detectLang(text: string): Lang | null {
  const kn = (text.match(/[\u0C80-\u0CFF]/g) ?? []).length
  const hi = (text.match(/[\u0900-\u097F]/g) ?? []).length
  if (kn || hi) return kn >= hi ? 'kn' : 'hi'
  return /[A-Za-z]{3}/.test(text) ? 'en' : null
}

const POLL_MS = 1500
const GIVE_UP_MS = 30_000

export type TranslateResult = { ok: true; text: string } | { ok: false; reason: 'failed' | 'unavailable' | 'same' }

/** Ask the server for a translation and wait while the worker makes it. */
export async function translateText(text: string, target: Lang, cancelled: () => boolean = () => false): Promise<TranslateResult> {
  const started = Date.now()
  for (;;) {
    const r = await api.translate(text, target)
    if (r.state === 'done' && r.text) return { ok: true, text: r.text }
    if (r.state === 'same') return { ok: false, reason: 'same' }
    if (r.state === 'unavailable') return { ok: false, reason: 'unavailable' }
    if (r.state !== 'pending' || Date.now() - started > GIVE_UP_MS || cancelled()) return { ok: false, reason: 'failed' }
    await new Promise((ok) => setTimeout(ok, POLL_MS))
  }
}

/**
 * Minimal HTTP client for the PCMS API.
 *
 * - Same-origin only; the session lives in an HttpOnly cookie the script cannot read.
 * - Unsafe methods send X-CSRF-Token (double-submit against the pcms_csrf cookie).
 * - Errors come back as HttpError with the server's {code, message, field_errors, request_id}.
 * - A 401 on an authenticated call fires 'pcms:session-ended' so the app returns to sign-in.
 */

export const API_BASE = '/api/v1'

export class HttpError extends Error {
  status: number
  code: string
  fieldErrors?: Record<string, string> | null
  requestId?: string | null

  constructor(status: number, code: string, message: string, fieldErrors?: Record<string, string> | null, requestId?: string | null) {
    super(message)
    this.status = status
    this.code = code
    this.fieldErrors = fieldErrors
    this.requestId = requestId
  }
}

let csrfToken: string | null = null

export function setCsrf(token: string | null) { csrfToken = token }

function csrfFromCookie(): string | null {
  const m = document.cookie.match(/(?:^|;\s*)pcms_csrf=([^;]+)/)
  return m ? decodeURIComponent(m[1]) : null
}

const SESSION_CODES = new Set(['unauthenticated', 'suspended', 'mfa_required', 'password_change_required'])

export interface RequestOptions {
  body?: unknown
  form?: FormData
  signal?: AbortSignal
  /** Do not broadcast session-ended on 401 (used by the sign-in flow itself). */
  quiet401?: boolean
  accept?: string
}

async function send(method: string, path: string, opts: RequestOptions = {}): Promise<Response> {
  const headers: Record<string, string> = { Accept: opts.accept ?? 'application/json' }
  if (method !== 'GET' && method !== 'HEAD') {
    const token = csrfToken ?? csrfFromCookie()
    if (token) headers['X-CSRF-Token'] = token
  }
  let body: BodyInit | undefined
  if (opts.form) body = opts.form
  else if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(opts.body)
  }
  let res: Response
  try {
    res = await fetch(API_BASE + path, { method, headers, body, credentials: 'same-origin', signal: opts.signal, cache: 'no-store' })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err
    throw new HttpError(0, 'offline', 'The campus network is unreachable. Check your Wi-Fi and try again.')
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({} as Record<string, unknown>))
    const code = typeof data.code === 'string' ? data.code : String(res.status)
    const message = typeof data.message === 'string' ? data.message : 'The request failed. Try again.'
    const err = new HttpError(res.status, code, message, data.field_errors as Record<string, string> | null, data.request_id as string | null)
    if (res.status === 401 && !opts.quiet401 && SESSION_CODES.has(code)) {
      window.dispatchEvent(new CustomEvent('pcms:session-ended', { detail: code }))
    }
    throw err
  }
  return res
}

export async function request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
  const res = await send(method, path, opts)
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

export async function requestBlob(method: string, path: string, opts: RequestOptions = {}): Promise<{ blob: Blob; filename: string; headers: Headers }> {
  const res = await send(method, path, { ...opts, accept: opts.accept ?? '*/*' })
  const cd = res.headers.get('content-disposition') ?? ''
  const m = cd.match(/filename="([^"]+)"/)
  return { blob: await res.blob(), filename: m ? m[1] : 'download', headers: res.headers }
}

export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v))
  const s = p.toString()
  return s ? `?${s}` : ''
}

/** Save a blob through a temporary object URL, then revoke it. */
export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

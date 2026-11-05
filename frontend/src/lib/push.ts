/**
 * Web push for this device.
 *
 * Requirements: HTTPS (or localhost), a registered service worker, and the
 * person's permission, which browsers only allow to be requested from a tap.
 * On iPhone and iPad, push works only after "Add to Home Screen".
 */
import { request } from './http'

export type PushState = 'unsupported' | 'needs-install' | 'disabled-on-server' | 'denied' | 'off' | 'on'

export function pushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && window.isSecureContext
}

function isIosBrowserTab(): boolean {
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  const standalone = window.matchMedia('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true
  return ios && !standalone
}

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(padded)
  const out = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null
  return (await navigator.serviceWorker.getRegistration()) ?? null
}

export async function pushState(): Promise<PushState> {
  if (isIosBrowserTab()) return 'needs-install'
  if (!pushSupported()) return 'unsupported'
  const cfg = await request<{ enabled: boolean; publicKey: string | null }>('GET', '/push/config')
  if (!cfg.enabled) return 'disabled-on-server'
  if (Notification.permission === 'denied') return 'denied'
  const reg = await registration()
  const sub = await reg?.pushManager.getSubscription()
  return sub ? 'on' : 'off'
}

/** Call only from a user gesture (button tap). */
export async function enablePush(): Promise<PushState> {
  setOptedOut(false)
  return subscribe()
}

/** Remembered per device: the person turned notifications off here, so never re-subscribe on open. */
const OPT_OUT_KEY = 'pcms.push.optedOut'
function optedOut(): boolean {
  try { return localStorage.getItem(OPT_OUT_KEY) === '1' } catch { return false }
}
function setOptedOut(v: boolean): void {
  try { if (v) localStorage.setItem(OPT_OUT_KEY, '1'); else localStorage.removeItem(OPT_OUT_KEY) } catch { /* private mode */ }
}

async function subscribe(): Promise<PushState> {
  const cfg = await request<{ enabled: boolean; publicKey: string | null }>('GET', '/push/config')
  if (!cfg.enabled || !cfg.publicKey) return 'disabled-on-server'
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') return permission === 'denied' ? 'denied' : 'off'
  const reg = await navigator.serviceWorker.ready
  const key = urlBase64ToUint8Array(cfg.publicKey)
  let sub = await reg.pushManager.getSubscription()
  // A subscription made with a different server key cannot receive our pushes.
  const current = sub?.options.applicationServerKey
  if (sub && current && !sameKey(new Uint8Array(current), key)) {
    await sub.unsubscribe()
    sub = null
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
  const json = sub.toJSON()
  await request('POST', '/push/subscriptions', { body: { endpoint: json.endpoint, keys: json.keys } })
  return 'on'
}

export async function disablePush(): Promise<PushState> {
  setOptedOut(true)
  await unsubscribeThisDevice()
  return 'off'
}

/** Remove this device's subscription on the server and in the browser (also used at sign-out). */
export async function unsubscribeThisDevice(): Promise<void> {
  const reg = await registration()
  const sub = await reg?.pushManager.getSubscription()
  if (!sub) return
  await request('DELETE', '/push/subscriptions', { body: { endpoint: sub.endpoint }, quiet401: true }).catch(() => undefined)
  await sub.unsubscribe().catch(() => undefined)
}

export async function sendTestPush(): Promise<{ sent: number; failed: number }> {
  return request('POST', '/push/test')
}

/**
 * Called every time a signed-in person opens the app. If notifications are
 * already allowed, the browser's current subscription is (re)saved on the
 * server, so a rotated or expired subscription is replaced automatically.
 * Returns the state so the UI can ask for permission when it is still 'off'.
 */
export async function syncPushOnOpen(): Promise<PushState> {
  const state = await pushState()
  // Turned off on this device: respect it until the person turns it back on.
  if (optedOut()) return state === 'on' ? 'on' : 'off'
  if (state === 'on' || (state === 'off' && typeof Notification !== 'undefined' && Notification.permission === 'granted')) {
    // Permission is already granted, so this needs no user gesture.
    return subscribe()
  }
  return state
}

/** True when the person turned notifications off on this device (the prompt should stay quiet). */
export function pushOptedOut(): boolean {
  return optedOut()
}

// ---------- keep the server's copy of this device's subscription current ----------

/** Re-save at most this often while the app stays open (it is also saved on every app open). */
const RESYNC_MS = 60 * 60 * 1000
let started = false
let lastSync = 0
let inFlight: Promise<PushState> | null = null

function resync(force = false): Promise<PushState> {
  if (inFlight) return inFlight
  if (!force && Date.now() - lastSync < RESYNC_MS) return Promise.resolve('on')
  inFlight = syncPushOnOpen()
    .finally(() => { lastSync = Date.now(); inFlight = null })
  return inFlight
}

/**
 * Called once after sign-in (from NotificationPrompt). Saves this device's push
 * subscription now, again whenever the app comes back to the foreground (at most
 * hourly), and immediately when the browser replaces the subscription (the service
 * worker reports `pushsubscriptionchange`). So the server always holds a working
 * subscription for every device a person uses, without them doing anything.
 */
export function startPushSync(onState?: (s: PushState) => void): void {
  const report = (p: Promise<PushState>) => { p.then((s) => onState?.(s)).catch(() => undefined) }
  report(resync(true))
  if (started) return
  started = true
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') report(resync())
  })
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (event) => {
      if ((event.data as { type?: string } | null)?.type === 'PCMS_PUSH_RESUBSCRIBE') report(resync(true))
    })
  }
}

function sameKey(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

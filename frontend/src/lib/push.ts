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
  if (state === 'on' || (state === 'off' && typeof Notification !== 'undefined' && Notification.permission === 'granted')) {
    return enablePush()
  }
  return state
}

function sameKey(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

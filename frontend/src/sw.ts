/// <reference lib="webworker" />
/**
 * PCMS service worker.
 *
 * Caches only the built app shell (precache manifest). API responses, media and
 * webhooks are never cached: authenticated data must not outlive the session
 * on a shared device (plan section 6).
 */
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching'
import { NavigationRoute, registerRoute } from 'workbox-routing'

declare const self: ServiceWorkerGlobalScope

cleanupOutdatedCaches()
precacheAndRoute(self.__WB_MANIFEST)

// SPA navigations fall back to the cached shell, except server-owned paths.
registerRoute(new NavigationRoute(createHandlerBoundToURL('/index.html'), {
  denylist: [/^\/api\//, /^\/media\//],
}))

// The page asks the waiting worker to take over after the person accepts the update.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') void self.skipWaiting()
})

interface PushPayload { title?: string; body?: string; url?: string; tag?: string }

self.addEventListener('push', (event) => {
  let data: PushPayload = {}
  try { data = event.data?.json() ?? {} } catch { data = { body: event.data?.text() } }
  const title = clip(data.title || 'PCMS', 100)
  const tag = data.tag?.slice(0, 64)
  event.waitUntil(self.registration.showNotification(title, {
    body: clip(data.body || 'There is an update on one of your tickets.', 240),
    icon: '/pwa-192x192.png',
    badge: '/pwa-64x64.png',
    tag,
    // A newer update on the same ticket replaces the old one but still alerts the person.
    renotify: !!tag,
    data: { url: safeUrl(data.url) },
  } as NotificationOptions & { renotify?: boolean }))
})

/** Shorten at a word boundary with "..." so a cut is visible (the server already does this). */
function clip(text: string, limit: number): string {
  const s = text.replace(/\s+/g, ' ').trim()
  if (s.length <= limit) return s
  let cut = s.slice(0, limit - 3)
  const space = cut.lastIndexOf(' ')
  if (space >= limit / 2) cut = cut.slice(0, space)
  return cut.replace(/[\s,.;:-]+$/, '') + '...'
}

// The browser replaced or dropped this device's push subscription (key rotation by the
// push service, browser update, storage cleared). Subscribe again with the same server key
// so pushes keep arriving, then ask every open page to save it on the server (the page
// holds the sign-in and CSRF token; the worker does not). A page that is not open saves
// it the next time the app opens.
self.addEventListener('pushsubscriptionchange', ((event: ExtendableEvent & { oldSubscription?: PushSubscription | null }) => {
  event.waitUntil((async () => {
    const key = event.oldSubscription?.options.applicationServerKey
    if (key) {
      try { await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }) } catch { /* the page re-subscribes */ }
    }
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const w of wins) w.postMessage({ type: 'PCMS_PUSH_RESUBSCRIBE' })
  })())
}) as EventListener)

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const target = safeUrl((event.notification.data as { url?: string } | null)?.url)
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const w of wins) {
      if (new URL(w.url).origin === self.location.origin) {
        await w.focus()
        await w.navigate(target).catch(() => undefined)
        return
      }
    }
    await self.clients.openWindow(target)
  })())
})

// Only ever open paths inside this app, never an external URL from a payload.
function safeUrl(url?: string): string {
  if (!url || !url.startsWith('/') || url.startsWith('//')) return '/'
  return url
}

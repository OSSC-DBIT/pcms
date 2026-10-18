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
  denylist: [/^\/api\//, /^\/webhooks\//, /^\/media\//],
}))

// The page asks the waiting worker to take over after the person accepts the update.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') void self.skipWaiting()
})

interface PushPayload { title?: string; body?: string; url?: string; tag?: string }

self.addEventListener('push', (event) => {
  let data: PushPayload = {}
  try { data = event.data?.json() ?? {} } catch { data = { body: event.data?.text() } }
  const title = (data.title || 'PCMS').slice(0, 80)
  event.waitUntil(self.registration.showNotification(title, {
    body: (data.body || 'There is an update on one of your tickets.').slice(0, 200),
    icon: '/pwa-192x192.png',
    badge: '/pwa-64x64.png',
    tag: data.tag?.slice(0, 64),
    data: { url: safeUrl(data.url) },
  }))
})

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

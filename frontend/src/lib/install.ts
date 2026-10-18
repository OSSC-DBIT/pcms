/**
 * "Install app" support. Chrome and Edge fire beforeinstallprompt once the PWA
 * is installable (HTTPS or localhost, manifest, service worker); we keep the
 * event and show our own button. iPhone and iPad never fire it, so we show
 * the Share > Add to Home Screen instructions instead.
 */
import { useEffect, useState } from 'react'

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

let deferred: BeforeInstallPromptEvent | null = null
const listeners = new Set<() => void>()
const notify = () => listeners.forEach((fn) => fn())

// Registered at module load (imported from main.tsx) so the event is not missed.
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault()
  deferred = e as BeforeInstallPromptEvent
  notify()
})
window.addEventListener('appinstalled', () => { deferred = null; notify() })

export function isStandalone(): boolean {
  return window.matchMedia('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true
}

export function isIos(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
}

export type InstallState = 'installed' | 'available' | 'ios' | 'unavailable'

export function useInstall(): { state: InstallState; install: () => Promise<void> } {
  const [, force] = useState(0)
  useEffect(() => {
    const fn = () => force((n) => n + 1)
    listeners.add(fn)
    return () => { listeners.delete(fn) }
  }, [])
  const state: InstallState = isStandalone() ? 'installed' : deferred ? 'available' : isIos() ? 'ios' : 'unavailable'
  return {
    state,
    install: async () => {
      if (!deferred) return
      await deferred.prompt()
      await deferred.userChoice
      deferred = null
      notify()
    },
  }
}

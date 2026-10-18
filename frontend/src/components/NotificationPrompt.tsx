import { useEffect, useState } from 'react'
import { Bell, X } from 'lucide-react'
import { enablePush, syncPushOnOpen, type PushState } from '../lib/push'
import { Button } from './ui'

const ASKED_KEY = 'pcms.push.asked'

/**
 * On every open: re-saves this device's push subscription, then asks for
 * permission if it has not been decided yet. Browsers (Safari always, Chrome
 * often) only show the permission dialog after a tap, so we show a banner with
 * a button rather than calling the dialog unprompted.
 */
export default function NotificationPrompt() {
  const [state, setState] = useState<PushState | null>(null)
  const [busy, setBusy] = useState(false)
  const [hidden, setHidden] = useState(() => sessionStorage.getItem(ASKED_KEY) === '1')

  useEffect(() => { syncPushOnOpen().then(setState).catch(() => setState(null)) }, [])

  if (hidden || state !== 'off' || typeof Notification === 'undefined' || Notification.permission !== 'default') return null
  const dismiss = () => { sessionStorage.setItem(ASKED_KEY, '1'); setHidden(true) }

  return (
    <div role="dialog" aria-label="Turn on notifications"
      className="fixed inset-x-3 top-3 z-50 mx-auto flex max-w-md items-start gap-3 rounded-lg border border-accent/30 bg-surface p-4 shadow-lg md:top-6">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent"><Bell size={18} /></span>
      <div className="min-w-0 flex-1">
        <p className="text-[15px] font-medium">Get updates on your tickets</p>
        <p className="mt-0.5 text-[13.5px] text-muted">Allow notifications to hear when a report is assigned, fixed or needs you.</p>
        <div className="mt-3 flex gap-2">
          <Button size="sm" loading={busy} onClick={async () => {
            setBusy(true)
            try { setState(await enablePush()) } catch { /* the banner stays; Settings has details */ } finally { setBusy(false); dismiss() }
          }}>Allow</Button>
          <Button size="sm" variant="ghost" onClick={dismiss}>Not now</Button>
        </div>
      </div>
      <button type="button" aria-label="Close" onClick={dismiss} className="-mr-1 -mt-1 flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-subtle"><X size={16} /></button>
    </div>
  )
}

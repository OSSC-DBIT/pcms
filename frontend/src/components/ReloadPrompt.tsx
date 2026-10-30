import { useRegisterSW } from 'virtual:pwa-register/react'
import { useT } from '../lib/i18n'
import { Button } from './ui'

const HOUR = 60 * 60 * 1000

/** Registers the service worker; offers new versions instead of reloading under the user (plan 27). */
export default function ReloadPrompt() {
  const { t } = useT()
  const { needRefresh: [needRefresh, setNeedRefresh], updateServiceWorker } = useRegisterSW({
    onRegisteredSW(_url, reg) { if (reg) setInterval(() => { void reg.update() }, HOUR) },
  })
  if (!needRefresh) return null
  return (
    <div role="status" className="fixed inset-x-4 bottom-20 z-50 mx-auto flex max-w-md items-center gap-3 rounded-lg border border-line bg-surface p-3 shadow-lg md:bottom-6">
      <p className="flex-1 text-[14px]">{t('reload.ready')}</p>
      <Button size="sm" variant="ghost" onClick={() => setNeedRefresh(false)}>{t('reload.later')}</Button>
      <Button size="sm" onClick={() => void updateServiceWorker(true)}>{t('reload.update')}</Button>
    </div>
  )
}

import { useState } from 'react'
import { Download, Share, X } from 'lucide-react'
import { useInstall } from '../lib/install'
import { useT } from '../lib/i18n'
import { Button } from './ui'

const DISMISS_KEY = 'pcms.install.dismissed'

/** Shows "Install app" when the browser allows it, or iPhone instructions. */
export default function InstallCard({ dismissible = false }: { dismissible?: boolean }) {
  const { t } = useT()
  const { state, install } = useInstall()
  const [hidden, setHidden] = useState(() => dismissible && localStorage.getItem(DISMISS_KEY) === '1')

  if (hidden || state === 'installed' || state === 'unavailable') {
    return !dismissible && state === 'installed' ? <p className="text-[14px] text-muted">{t('install.installed')}</p> : null
  }
  return (
    <div className="flex items-start gap-3 rounded-lg border border-accent/30 bg-accent-soft p-4">
      <img src="/pwa-64x64.png" alt="" width={40} height={40} className="rounded-md" />
      <div className="min-w-0 flex-1">
        <p className="text-[15px] font-medium">{t('install.title')}</p>
        <p className="mt-0.5 text-[13.5px] text-muted">
          {state === 'ios' ? <span className="inline-flex items-center gap-1"><Share size={14} /> {t('install.ios')}</span> : t('install.body')}
        </p>
        {state === 'available' && <Button size="sm" className="mt-3" onClick={install}><Download size={15} /> {t('install.button')}</Button>}
      </div>
      {dismissible && (
        <button type="button" aria-label={t('install.dismiss')} onClick={() => { localStorage.setItem(DISMISS_KEY, '1'); setHidden(true) }}
          className="-mr-1 -mt-1 flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-surface"><X size={16} /></button>
      )}
    </div>
  )
}

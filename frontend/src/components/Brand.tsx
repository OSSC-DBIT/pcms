/** Institution branding shown on every page: Don Bosco Institute of Technology and OSSC DBIT. */
import { clsx } from 'clsx'
import { Languages } from 'lucide-react'
import { LANGS, useT, type Lang } from '../lib/i18n'

/**
 * English, Kannada or Hindi, available on every screen (sidebar, phone header,
 * sign-in and landing pages). The choice is remembered on this device.
 */
export function LanguageSwitcher({ compact }: { compact?: boolean }) {
  const { t, lang, setLang } = useT()
  return (
    <label className={clsx('flex items-center gap-2 text-muted', compact ? 'text-[12.5px]' : 'text-[13px]')}>
      <Languages size={compact ? 15 : 16} aria-hidden />
      <span className={compact ? 'sr-only' : ''}>{t('nav.language')}</span>
      <select value={lang} onChange={(e) => setLang(e.target.value as Lang)} aria-label={t('nav.language')}
        className="min-h-8 rounded-md border border-line bg-surface px-2 text-[13px] text-fg">
        {LANGS.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
      </select>
    </label>
  )
}

export const INSTITUTE = 'Don Bosco Institute of Technology, Bengaluru'
export const INSTITUTE_SHORT = 'DBIT Bengaluru'
export const CLUB = 'Open Source Student Club, DBIT'
export const INSTITUTE_URL = 'https://dbit.edu.in'

export function InstituteMark({ className }: { className?: string }) {
  return (
    <div className={clsx('flex items-center gap-2.5', className)}>
      <img src="/pwa-64x64.png" alt="" width={32} height={32} className="rounded-md" />
      <div className="leading-tight">
        <p className="text-[15px] font-semibold">PCMS</p>
        <p className="text-[12px] text-muted">{INSTITUTE_SHORT}</p>
      </div>
    </div>
  )
}

/** compact: the narrow version pinned to the bottom of the desktop sidebar. */
export function Footer({ className, compact }: { className?: string; compact?: boolean }) {
  const { t } = useT()
  return (
    <footer className={clsx('border-t border-line text-muted',
      compact ? 'px-5 py-3 text-left text-[11.5px] leading-4' : 'px-4 py-5 text-center text-[12.5px] leading-5', className)}>
      <p>
        <a href={INSTITUTE_URL} target="_blank" rel="noopener noreferrer" className="font-medium text-fg hover:text-accent">{INSTITUTE}</a>
        {' · '}Mysuru Road, Kumbalagodu, Bengaluru 560074
      </p>
      <p className="mt-1">{t('footer.maintained', { club: CLUB })}</p>
      <p className="mt-1">{t('footer.rights', { year: new Date().getFullYear(), institute: INSTITUTE, club: CLUB })}</p>
    </footer>
  )
}

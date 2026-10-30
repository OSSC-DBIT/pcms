/** Institution branding shown on every page: Don Bosco Institute of Technology and OSSC DBIT. */
import { clsx } from 'clsx'
import { useT } from '../lib/i18n'

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

export function Footer({ className }: { className?: string }) {
  const { t } = useT()
  return (
    <footer className={clsx('border-t border-line px-4 py-5 text-center text-[12.5px] leading-5 text-muted', className)}>
      <p>
        <a href={INSTITUTE_URL} target="_blank" rel="noopener noreferrer" className="font-medium text-fg hover:text-accent">{INSTITUTE}</a>
        {' · '}Mysuru Road, Kumbalagodu, Bengaluru 560074
      </p>
      <p className="mt-1">{t('footer.maintained', { club: CLUB })}</p>
      <p className="mt-1">{t('footer.rights', { year: new Date().getFullYear(), institute: INSTITUTE, club: CLUB })}</p>
    </footer>
  )
}

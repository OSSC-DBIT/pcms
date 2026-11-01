/**
 * English / Kannada / Hindi buttons under a text box, for the facility manager only
 * (DBIT, 2026-11-01: he is not fluent in English; everyone else writes as they like). The highlighted one is the language
 * the text is written in; tapping another rewrites the text in that language (machine
 * translation by the PCMS server), with Undo to get the typed words back.
 */
import { clsx } from 'clsx'
import { Languages, Loader2, Undo2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../App'
import { detectLang, translateText } from '../lib/translate'
import { LANGS, useT, type Lang } from '../lib/i18n'


export function LanguageButtons({ value, onChange, maxLength }: { value: string; onChange: (v: string) => void; maxLength?: number }) {
  const { t } = useT()
  const { user } = useAuth()
  const [busy, setBusy] = useState<Lang | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [undo, setUndo] = useState<string | null>(null)
  const cancelled = useRef(false)
  useEffect(() => () => { cancelled.current = true }, [])
  const current = detectLang(value)
  if (user?.role !== 'facility_manager') return null

  async function to(target: Lang) {
    const text = value.trim()
    if (!text || target === current || busy) return
    setBusy(target); setError(null)
    try {
      const r = await translateText(text, target, () => cancelled.current)
      if (cancelled.current) return
      if (r.ok) {
        setUndo(value)
        onChange(maxLength ? r.text.slice(0, maxLength) : r.text)
      } else if (r.reason !== 'same') {
        setError(t(r.reason === 'unavailable' ? 'translate.unavailable' : 'translate.failed'))
      }
    } catch {
      setError(t('translate.failed'))
    } finally {
      if (!cancelled.current) setBusy(null)
    }
  }

  return (
    <div className="mt-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <Languages size={15} className="text-muted" aria-hidden />
        <span className="sr-only">{t('translate.convertTo')}</span>
        {LANGS.map((l) => (
          <button key={l.code} type="button" disabled={!value.trim() || !!busy}
            aria-pressed={current === l.code} onClick={() => void to(l.code)}
            className={clsx('inline-flex h-8 items-center gap-1 rounded-full border px-3 text-[13px] transition-colors disabled:opacity-50',
              current === l.code ? 'border-accent bg-accent-soft font-medium text-accent' : 'border-line bg-surface text-fg hover:bg-subtle')}>
            {busy === l.code && <Loader2 size={13} className="animate-spin" aria-hidden />}
            {l.label}
          </button>
        ))}
        {undo !== null && !busy && (
          <button type="button" onClick={() => { onChange(undo); setUndo(null) }}
            className="inline-flex h-8 items-center gap-1 px-2 text-[13px] text-accent hover:underline">
            <Undo2 size={14} aria-hidden /> {t('translate.undo')}
          </button>
        )}
      </div>
      {busy && <p className="mt-1 text-[12.5px] text-muted" role="status">{t('translate.working')}</p>}
      {error && <p className="mt-1 text-[12.5px] text-bad" role="alert">{error}</p>}
    </div>
  )
}

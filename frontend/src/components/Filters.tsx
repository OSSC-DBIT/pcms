/**
 * Ticket filters kept in the address bar (?severity=red&building=BLOCK_A...), so a refresh,
 * the back button or a shared link keeps the same list. Every filter is applied by the server.
 */
import { clsx } from 'clsx'
import { Search, SlidersHorizontal, X } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useT } from '../lib/i18n'
import { Button, Input } from './ui'

/** Read and write one set of string filters in the URL. Changing any of them drops the page number. */
export function useUrlFilters<K extends string>(keys: readonly K[]) {
  const [params, setParams] = useSearchParams()
  const values = Object.fromEntries(keys.map((k) => [k, params.get(k) ?? ''])) as Record<K, string>
  const set = (patch: Partial<Record<K, string>>) => setParams((p) => {
    const next = new URLSearchParams(p)
    for (const [k, v] of Object.entries(patch) as [K, string][]) {
      if (v) next.set(k, v)
      else next.delete(k)
    }
    return next
  }, { replace: true })
  const clear = (except: K[] = []) => set(Object.fromEntries(keys.filter((k) => !except.includes(k)).map((k) => [k, ''])) as Partial<Record<K, string>>)
  return { values, set, clear }
}

/** A search box that applies on Enter or after the person stops typing. */
export function SearchBox({ value, onSearch, placeholder, id }: { value: string; onSearch: (v: string) => void; placeholder: string; id: string }) {
  const { t } = useT()
  const [text, setText] = useState(value)
  const [timer, setTimer] = useState<ReturnType<typeof setTimeout> | null>(null)
  // Follow the URL when it changes from outside (Clear, back button); keep what is being typed otherwise.
  const [seen, setSeen] = useState(value)
  if (value !== seen) {
    setSeen(value)
    if (value !== text.trim()) setText(value)
  }
  return (
    <form role="search" className="relative min-w-0 flex-1 basis-full sm:basis-0" onSubmit={(e) => { e.preventDefault(); onSearch(text.trim()) }}>
      <label htmlFor={id} className="sr-only">{t('action.search')}</label>
      <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" aria-hidden />
      <Input id={id} value={text} placeholder={placeholder} autoComplete="off" className="pl-9 pr-9" type="search"
        onChange={(e) => {
          const v = e.target.value
          setText(v)
          if (timer) clearTimeout(timer)
          setTimer(setTimeout(() => onSearch(v.trim()), 450))
        }} />
      {text && (
        <button type="button" aria-label={t('action.clear')} onClick={() => { setText(''); onSearch('') }}
          className="absolute right-2 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded text-muted hover:bg-subtle">
          <X size={15} />
        </button>
      )}
    </form>
  )
}

/** "Filters (3)" toggle for the panel of extra filters. */
export function FilterToggle({ open, count, onClick }: { open: boolean; count: number; onClick: () => void }) {
  const { t } = useT()
  return (
    <Button variant="secondary" onClick={onClick} aria-expanded={open}>
      <SlidersHorizontal size={16} /> {open ? t('filter.hide') : t('filter.button')}
      {count > 0 && <span className="rounded-full bg-accent px-1.5 text-[12px] font-semibold leading-5 text-accent-fg">{count}</span>}
    </Button>
  )
}

export interface Chip { key: string; label: ReactNode; onRemove: () => void }

/** The filters in use, each removable with one tap. */
export function FilterChips({ chips, onClearAll }: { chips: Chip[]; onClearAll: () => void }) {
  const { t } = useT()
  if (!chips.length) return null
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {chips.map((c) => (
        <span key={c.key} className="inline-flex h-8 items-center gap-1 rounded-full border border-accent/30 bg-accent-soft pl-3 pr-1 text-[13px] text-accent">
          {c.label}
          <button type="button" onClick={c.onRemove} aria-label={t('filter.remove', { name: String(c.label) })}
            className="flex h-6 w-6 items-center justify-center rounded-full hover:bg-accent/15"><X size={13} /></button>
        </span>
      ))}
      <button type="button" onClick={onClearAll} className="px-2 text-[13px] text-muted hover:text-fg hover:underline">{t('action.clear')}</button>
    </div>
  )
}

/** A labelled control inside the filter panel. */
export function FilterField({ label, htmlFor, children, wide }: { label: string; htmlFor: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className={clsx('min-w-0', wide && 'sm:col-span-2')}>
      <label htmlFor={htmlFor} className="mb-1.5 block text-[13px] font-medium">{label}</label>
      {children}
    </div>
  )
}

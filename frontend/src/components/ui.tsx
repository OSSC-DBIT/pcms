/**
 * Shared UI components. Every page builds from these so behaviour and look stay consistent.
 * Mobile first; the same components lay out wider on desktop.
 */
import { clsx } from 'clsx'
import { ChevronDown, Loader2, X } from 'lucide-react'
import { useEffect, useId, useRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode,
  type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react'
import type { Status } from '../lib/types'
import { useT } from '../lib/i18n'

// ---------- buttons ----------

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'

export function Button({ variant = 'primary', size = 'md', loading, full, className, children, disabled, type = 'button', ...rest }:
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: 'sm' | 'md'; loading?: boolean; full?: boolean }) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={clsx(
        'inline-flex select-none items-center justify-center gap-2 rounded-md font-medium transition-colors',
        'disabled:cursor-not-allowed disabled:opacity-50',
        size === 'md' ? 'h-11 px-4 text-[15px]' : 'h-9 px-3 text-[14px]',
        full && 'w-full',
        variant === 'primary' && 'bg-accent text-accent-fg hover:opacity-90',
        variant === 'secondary' && 'border border-line bg-surface text-fg hover:bg-subtle',
        variant === 'ghost' && 'text-fg hover:bg-subtle',
        variant === 'danger' && 'border border-bad/40 bg-surface text-bad hover:bg-bad-soft',
        className,
      )}
      {...rest}
    >
      {loading && <Loader2 size={16} className="animate-spin" aria-hidden />}
      {children}
    </button>
  )
}

// ---------- layout ----------

export function PageHeader({ title, subtitle, actions, back }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; back?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        {back}
        <h1 className="text-[22px] font-semibold leading-tight md:text-[26px]">{title}</h1>
        {subtitle && <p className="mt-1 text-[14.5px] text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap gap-2">{actions}</div>}
    </div>
  )
}

export function Card({ title, subtitle, actions, children, className, padded = true }: { title?: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; padded?: boolean }) {
  return (
    <section className={clsx('rounded-lg border border-line bg-surface', padded && 'p-4 md:p-5', className)}>
      {(title || actions) && (
        <div className={clsx('mb-3 flex items-start justify-between gap-3', !padded && 'px-4 pt-4')}>
          <div className="min-w-0">
            {title && <h2 className="text-[16px] font-semibold">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-[13px] text-muted">{subtitle}</p>}
          </div>
          {actions}
        </div>
      )}
      {children}
    </section>
  )
}

export function Stack({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={clsx('space-y-4', className)}>{children}</div>
}

// ---------- form controls ----------

export function Field({ label, hint, error, optional, children, id }: { label: ReactNode; hint?: ReactNode; error?: string | null; optional?: boolean; children: (id: string, describedBy?: string) => ReactNode; id?: string }) {
  const { t } = useT()
  const auto = useId()
  const fid = id ?? auto
  const hintId = hint ? `${fid}-hint` : undefined
  const errId = error ? `${fid}-err` : undefined
  return (
    <div>
      <label htmlFor={fid} className="mb-1.5 block text-[14px] font-medium">
        {label}{optional && <span className="ml-1 font-normal text-muted">({t('form.optional')})</span>}
      </label>
      {children(fid, [hintId, errId].filter(Boolean).join(' ') || undefined)}
      {hint && !error && <p id={hintId} className="mt-1 text-[13px] text-muted">{hint}</p>}
      {error && <p id={errId} role="alert" className="mt-1 text-[13px] text-bad">{error}</p>}
    </div>
  )
}

const control = 'w-full rounded-md border border-line bg-surface px-3.5 text-fg placeholder:text-muted/70 focus:border-accent aria-[invalid=true]:border-bad'

export function Input({ className, invalid, ...p }: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  return <input {...p} aria-invalid={invalid || undefined} className={clsx(control, 'h-11', className)} />
}

export function Textarea({ className, invalid, ...p }: TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }) {
  return <textarea {...p} aria-invalid={invalid || undefined} className={clsx(control, 'min-h-24 py-2.5 leading-6', className)} />
}

export function Select({ className, invalid, children, ...p }: SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }) {
  return (
    <div className="relative">
      <select {...p} aria-invalid={invalid || undefined} className={clsx(control, 'h-11 appearance-none pr-10', className)}>{children}</select>
      <ChevronDown size={16} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted" aria-hidden />
    </div>
  )
}

export function Checkbox({ label, checked, onChange }: { label: ReactNode; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex min-h-11 cursor-pointer items-center gap-3 text-[15px]">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="h-5 w-5 accent-[var(--c-accent)]" />
      {label}
    </label>
  )
}

/** Single choice shown as tappable chips (good for short lists). */
export function Chips<T extends string>({ options, value, onChange, label, invalid }:
  { options: { value: T; label: ReactNode }[]; value: T | '' | undefined; onChange: (v: T) => void; label: string; invalid?: boolean }) {
  return (
    <div role="radiogroup" aria-label={label} aria-invalid={invalid || undefined} className="flex flex-wrap gap-2">
      {options.map((o) => {
        const on = value === o.value
        return (
          <button key={o.value} type="button" role="radio" aria-checked={on} onClick={() => onChange(o.value)}
            className={clsx('min-h-10 rounded-full border px-4 text-[14.5px] transition-colors',
              on ? 'border-accent bg-accent text-accent-fg' : 'border-line bg-surface hover:bg-subtle')}>
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

/** Single choice shown as full-width rows with an optional description. */
export function RadioList<T extends string>({ options, value, onChange, name }:
  { options: { value: T; label: ReactNode; description?: ReactNode }[]; value: T; onChange: (v: T) => void; name: string }) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {options.map((o) => (
        <label key={o.value} className={clsx('flex min-h-12 cursor-pointer items-start gap-3 rounded-md border px-3.5 py-3',
          value === o.value ? 'border-accent bg-accent-soft' : 'border-line bg-surface hover:bg-subtle')}>
          <input type="radio" name={name} checked={value === o.value} onChange={() => onChange(o.value)} className="mt-0.5 h-5 w-5 accent-[var(--c-accent)]" />
          <span>
            <span className="block text-[15px] font-medium">{o.label}</span>
            {o.description && <span className="block text-[13px] text-muted">{o.description}</span>}
          </span>
        </label>
      ))}
    </div>
  )
}

export function Tabs<T extends string>({ tabs, value, onChange, label }: { tabs: { value: T; label: ReactNode }[]; value: T; onChange: (v: T) => void; label: string }) {
  return (
    <div role="tablist" aria-label={label} className="inline-flex rounded-md border border-line bg-subtle p-1">
      {tabs.map((tb) => (
        <button key={tb.value} role="tab" type="button" aria-selected={value === tb.value} onClick={() => onChange(tb.value)}
          className={clsx('min-h-9 rounded-[6px] px-4 text-[14px] font-medium', value === tb.value ? 'bg-surface shadow-sm' : 'text-muted hover:text-fg')}>
          {tb.label}
        </button>
      ))}
    </div>
  )
}

// ---------- feedback ----------

type Tone = 'info' | 'ok' | 'warn' | 'bad'

const TONE: Record<Tone, string> = {
  info: 'border-accent/30 bg-accent-soft text-fg',
  ok: 'border-ok/30 bg-ok-soft text-fg',
  warn: 'border-warn/30 bg-warn-soft text-fg',
  bad: 'border-bad/30 bg-bad-soft text-fg',
}

export function Alert({ tone = 'info', title, children, action }: { tone?: Tone; title?: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div role={tone === 'bad' ? 'alert' : 'status'} className={clsx('rounded-md border px-4 py-3 text-[14px] leading-5', TONE[tone])}>
      {title && <p className="font-medium">{title}</p>}
      {children && <div className={clsx(title && 'mt-0.5')}>{children}</div>}
      {action && <div className="mt-2.5">{action}</div>}
    </div>
  )
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return <div role="status" className="flex items-center justify-center gap-2 py-10 text-[14px] text-muted"><Loader2 size={18} className="animate-spin" /> {label}...</div>
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={clsx('animate-pulse rounded-md bg-subtle', className)} />
}

export function EmptyState({ title, body, action }: { title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-line bg-surface px-6 py-10 text-center">
      <p className="text-[16px] font-medium">{title}</p>
      {body && <p className="mx-auto mt-1 max-w-sm text-[14px] text-muted">{body}</p>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  )
}

const STATUS_TONE: Record<Status, string> = {
  Submitted: 'bg-accent-soft text-accent',
  Triaged: 'bg-accent-soft text-accent',
  Assigned: 'bg-warn-soft text-warn',
  InProgress: 'bg-warn-soft text-warn',
  OnHold: 'bg-subtle text-muted',
  AwaitingApproval: 'bg-warn-soft text-warn',
  Resolved: 'bg-ok-soft text-ok',
  Closed: 'bg-subtle text-muted',
  Cancelled: 'bg-subtle text-muted',
  Rejected: 'bg-bad-soft text-bad',
  Duplicate: 'bg-subtle text-muted',
}

export function StatusBadge({ status }: { status: Status }) {
  const { t } = useT()
  return <span className={clsx('inline-flex whitespace-nowrap rounded-full px-2.5 py-0.5 text-[12.5px] font-medium', STATUS_TONE[status])}>{t(`status.${status}`)}</span>
}

export function Badge({ children, tone }: { children: ReactNode; tone?: Tone }) {
  return <span className={clsx('inline-flex items-center rounded-full border px-2 py-0.5 text-[12px] font-medium',
    tone ? TONE[tone] : 'border-line text-muted')}>{children}</span>
}

// ---------- dialog ----------

/** Accessible modal built on <dialog>: focus is trapped and Escape closes it. */
export function Dialog({ open, onClose, title, children, footer, wide }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) d.showModal()
    if (!open && d.open) d.close()
  }, [open])
  return (
    <dialog ref={ref} onClose={onClose} onCancel={(e) => { e.preventDefault(); onClose() }}
      className={clsx('m-auto w-[calc(100%-2rem)] rounded-lg border border-line bg-surface p-0 text-fg shadow-xl', wide ? 'max-w-3xl' : 'max-w-md')}>
      {open && (
        <div className="p-5">
          <div className="mb-3 flex items-start justify-between gap-3">
            <h2 className="text-[17px] font-semibold">{title}</h2>
            <button type="button" onClick={onClose} aria-label="Close" className="-mr-2 -mt-1 flex h-9 w-9 items-center justify-center rounded-md hover:bg-subtle"><X size={18} /></button>
          </div>
          {children}
          {footer && <div className="mt-5 flex flex-wrap justify-end gap-2">{footer}</div>}
        </div>
      )}
    </dialog>
  )
}

export function errorMessage(err: unknown, fallback = 'Something went wrong. Try again.'): string {
  if (err && typeof err === 'object' && 'message' in err) {
    const e = err as { message: string; fieldErrors?: Record<string, string> | null }
    if (e.fieldErrors && Object.keys(e.fieldErrors).length) return `${e.message} ${Object.values(e.fieldErrors).join(' ')}`
    return e.message
  }
  return fallback
}

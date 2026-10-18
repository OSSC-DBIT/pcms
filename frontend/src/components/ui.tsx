import { motion, AnimatePresence, type Transition } from 'framer-motion'
import { ChevronLeft, ChevronRight, Loader2, X } from 'lucide-react'
import { clsx } from 'clsx'
import { useEffect, type ButtonHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type InputHTMLAttributes } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { useT, type TKey } from '../lib/i18n'
import type { Status } from '../lib/types'

export const spring: Transition = { type: 'spring', stiffness: 420, damping: 36, mass: 0.85 }
export const sheetSpring: Transition = { type: 'spring', stiffness: 380, damping: 34 }

/* ————— Button ————— */
export function Button({ variant = 'primary', loading, className, children, disabled, ...rest }:
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'destructive'; loading?: boolean }) {
  const busy = disabled || loading
  return (
    <motion.button
      whileTap={busy ? undefined : { scale: 0.975, opacity: 0.9 }}
      transition={spring}
      aria-disabled={busy || undefined}
      disabled={busy}
      className={clsx(
        'inline-flex h-[50px] w-full select-none items-center justify-center gap-2 rounded-[13px] px-5 text-[15.5px] font-semibold tracking-[-0.005em]',
        'disabled:pointer-events-none disabled:opacity-35',
        variant === 'primary' && 'bg-inverse text-inverse-fg shadow-[0_1px_2px_rgba(0,0,0,0.08)]',
        variant === 'secondary' && 'border border-line bg-surface text-fg',
        variant === 'ghost' && 'bg-transparent text-muted',
        variant === 'destructive' && 'bg-surface text-fg border border-line',
        className,
      )}
      {...(rest as object)}
    >
      {loading && <Loader2 size={16} className="animate-spin" />}
      {children}
    </motion.button>
  )
}

/* ————— Navigation ————— */
export function NavBar({ title, onBack, right, transparent }: { title?: ReactNode; onBack?: () => void; right?: ReactNode; transparent?: boolean }) {
  const navigate = useNavigate()
  const { t } = useT()
  const back = onBack ?? (() => navigate(-1))
  return (
    <header className={clsx('safe-top sticky top-0 z-30', transparent ? 'bg-transparent' : 'border-b border-line bg-bg/85 backdrop-blur-2xl')}>
      <div className="mx-auto flex h-[52px] max-w-lg items-center gap-1 px-2">
        <button onClick={back} aria-label={t('action.back')}
          className="flex h-[42px] w-[42px] items-center justify-center rounded-full text-fg transition-transform active:scale-90 active:bg-fg/8">
          <ChevronLeft size={23} strokeWidth={1.8} />
        </button>
        <div className="min-w-0 flex-1 truncate text-center text-[15.5px] font-semibold tracking-[-0.01em]">{title}</div>
        <div className="flex h-[42px] w-[42px] items-center justify-center">{right}</div>
      </div>
    </header>
  )
}

export function LargeHeader({ title, subtitle, right }: { title: string; subtitle?: string; right?: ReactNode }) {
  return (
    <div className="flex items-end justify-between px-4 pb-1 pt-8">
      <div className="min-w-0">
        <h1 className="balance text-[27px] font-bold tracking-[-0.03em]">{title}</h1>
        {subtitle && <p className="pretty mt-1 text-[14px] leading-5 text-muted">{subtitle}</p>}
      </div>
      {right}
    </div>
  )
}

export function SectionLabel({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between px-7 pb-1.5 pt-7">
      <p className="text-[12.5px] font-medium uppercase tracking-[0.04em] text-muted">{children}</p>
      {action}
    </div>
  )
}

/* ————— Surfaces ————— */
export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={clsx('overflow-hidden rounded-[14px] bg-surface shadow-[0_1px_2px_rgba(0,0,0,0.05)]', className)}>
      {children}
    </div>
  )
}

export function Row({ title, detail, right, onClick, chevron = true, selected }:
  { title: ReactNode; detail?: ReactNode; right?: ReactNode; onClick?: () => void; chevron?: boolean; selected?: boolean }) {
  const inner = (
    <div className="flex min-h-[56px] w-full items-center gap-3 px-4 py-2.5 text-left">
      <div className="min-w-0 flex-1">
        <p className="truncate text-[15.5px] font-medium tracking-[-0.005em]">{title}</p>
        {detail && <p className="pretty mt-0.5 line-clamp-2 text-[13px] leading-4 text-muted">{detail}</p>}
      </div>
      {right}
      {onClick && chevron && <ChevronRight size={17} className="shrink-0 text-muted/50" strokeWidth={2} />}
      {selected && <span className="h-2 w-2 shrink-0 rounded-full bg-fg" />}
    </div>
  )
  if (!onClick) return <div className="bg-surface">{inner}</div>
  return (
    <motion.button whileTap={{ scale: 0.99 }} onClick={onClick} className="block w-full bg-surface transition-colors active:bg-fg/5">
      {inner}
    </motion.button>
  )
}

/* ————— Sheet (bottom) ————— */
export function Sheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    if (open) addEventListener('keydown', k)
    return () => removeEventListener('keydown', k)
  }, [open, onClose])
  if (typeof document === 'undefined') return null
  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }}
          className="fixed inset-0 z-50 bg-black/45 backdrop-blur-[2px]" onClick={onClose}>
          <motion.div
            initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }} transition={sheetSpring}
            onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={title}
            className="safe-bottom absolute inset-x-0 bottom-auto top-0 mx-auto flex max-h-[85dvh] max-w-lg flex-col rounded-b-[22px] bg-bg shadow-2xl"
          >
            <div className="flex items-center justify-between px-4 pb-2 pt-5">
              <p className="text-[17px] font-semibold tracking-[-0.01em]">{title}</p>
              <button onClick={onClose} aria-label="Close" className="flex h-8 w-8 items-center justify-center rounded-full bg-fg/8 text-muted active:scale-90 transition-transform">
                <X size={15} strokeWidth={2.2} />
              </button>
            </div>
            <div className="overflow-y-auto overscroll-contain pb-4">{children}</div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  )
}

/* ————— Status (grayscale weight system) ————— */
const STATUS_STYLE: Record<Status, string> = {
  Submitted: 'border border-fg/30 text-fg',
  Triaged: 'border border-fg/30 text-fg',
  Assigned: 'bg-inverse text-inverse-fg',
  InProgress: 'bg-inverse text-inverse-fg',
  OnHold: 'border border-fg/30 text-muted',
  AwaitingApproval: 'bg-inverse text-inverse-fg',
  Resolved: 'border border-fg/30 text-fg',
  Closed: 'border border-line text-muted',
  Cancelled: 'border border-line text-muted',
  Rejected: 'border border-line text-muted',
  Duplicate: 'border border-line text-muted',
}

export function StatusChip({ status }: { status: Status }) {
  const { t } = useT()
  return (
    <span className={clsx('inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-[3px] text-[11.5px] font-semibold tracking-[0.01em]', STATUS_STYLE[status])}>
      {t(`status.${status}` as TKey)}
    </span>
  )
}

export function FlagMark({ flag }: { flag: 'I' | 'C' | 'P' }) {
  return (
    <span className="token inline-flex h-[18px] w-[18px] items-center justify-center rounded-full border border-fg/35 text-[10.5px] font-bold" title="Work flag">
      {flag}
    </span>
  )
}

/* ————— Forms ————— */
export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: ReactNode }) {
  return (
    <label className="block px-4 py-3">
      <span className="mb-2 flex items-baseline justify-between">
        <span className="text-[13px] font-semibold text-fg">{label}</span>
        {hint && <span className="text-[12px] text-muted">{hint}</span>}
      </span>
      {children}
      {error && <span role="alert" className="mt-1.5 block text-[13px] font-medium">{error}</span>}
    </label>
  )
}

const inputBase =
  'w-full rounded-[11px] border border-line bg-surface px-3.5 py-3 text-[16px] text-fg placeholder:text-muted/55 transition-colors focus:border-fg/50'

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={clsx(inputBase, props.className)} />
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={clsx(inputBase, 'appearance-none', props.className)} />
}

export function Segmented<T extends string>({ options, value, onChange, label }:
  { options: { value: T; label: ReactNode }[]; value: T; onChange: (v: T) => void; label?: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex rounded-[11px] bg-fg/8 p-[3px]">
      {options.map((o) => (
        <button key={o.value} role="radio" aria-checked={value === o.value} onClick={() => onChange(o.value)}
          className="relative flex-1 rounded-lg px-2 py-[7px] text-[13.5px] font-semibold text-muted transition-colors">
          {value === o.value && (
            <motion.span layoutId={`seg-${label ?? 'x'}`} transition={spring} className="absolute inset-0 rounded-lg bg-surface shadow-[0_1px_3px_rgba(0,0,0,0.12)]" />
          )}
          <span className={clsx('relative z-10', value === o.value && 'text-fg')}>{o.label}</span>
        </button>
      ))}
    </div>
  )
}

export function CheckChip({ selected, children, onClick, disabled }: { selected: boolean; children: ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <motion.button whileTap={{ scale: 0.95 }} onClick={onClick} disabled={disabled} aria-pressed={selected}
      className={clsx(
        'rounded-full border px-3.5 py-[7px] text-[14px] font-medium transition-colors disabled:opacity-35',
        selected ? 'border-transparent bg-inverse text-inverse-fg shadow-[0_1px_2px_rgba(0,0,0,0.1)]' : 'border-line bg-surface text-fg')}>
      {children}
    </motion.button>
  )
}

/* ————— States ————— */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={clsx('skeleton rounded-[10px]', className)} />
}

export function EmptyState({ icon, title, body, action }: { icon?: ReactNode; title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="mx-4 my-8 flex flex-col items-center rounded-[18px] border border-dashed border-fg/20 px-6 py-12 text-center">
      {icon && <div className="mb-3 text-muted/60">{icon}</div>}
      <p className="text-[16.5px] font-semibold tracking-[-0.01em]">{title}</p>
      {body && <p className="pretty mx-auto mt-1.5 max-w-[32ch] text-[13.5px] leading-5 text-muted">{body}</p>}
      {action && <div className="mt-6 w-full max-w-[220px]">{action}</div>}
    </div>
  )
}

export function Banner({ children, tone = 'line' }: { children: ReactNode; tone?: 'line' | 'inverse' }) {
  return (
    <motion.p initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} transition={spring} role="status"
      className={clsx('pretty rounded-[13px] px-4 py-3 text-[13.5px] leading-5',
        tone === 'inverse' ? 'bg-inverse text-inverse-fg' : 'border border-line bg-surface text-fg')}>
      {children}
    </motion.p>
  )
}

/* ————— Motion ————— */
export function Fade({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.18 }} className={className}>
      {children}
    </motion.div>
  )
}

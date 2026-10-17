import { motion, type Transition } from 'framer-motion'
import { ChevronLeft, Loader2 } from 'lucide-react'
import { clsx } from 'clsx'
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react'
import { useNavigate } from 'react-router-dom'
import { useT } from '../lib/i18n'
import type { Status } from '../lib/types'
import { labelStatus } from '../lib/api'

export const spring: Transition = { type: 'spring', stiffness: 420, damping: 34, mass: 0.8 }

export function Button({ variant = 'primary', loading, className, children, disabled, ...rest }:
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'outline' | 'ghost' | 'danger'; loading?: boolean }) {
  return (
    <motion.button
      whileTap={{ scale: 0.97 }}
      transition={spring}
      className={clsx(
        'inline-flex h-12 w-full select-none items-center justify-center gap-2 rounded-md px-5 text-[15px] font-medium',
        'disabled:pointer-events-none disabled:opacity-40',
        variant === 'primary' && 'bg-inverse text-inverse-fg',
        variant === 'outline' && 'border border-line bg-transparent text-fg',
        variant === 'ghost' && 'bg-transparent text-muted hover:text-fg',
        variant === 'danger' && 'border border-line bg-transparent text-fg underline decoration-1 underline-offset-4',
        className,
      )}
      disabled={disabled || loading}
      {...(rest as object)}
    >
      {loading && <Loader2 size={16} className="animate-spin" />}
      {children}
    </motion.button>
  )
}

export function NavBar({ title, onBack, right }: { title?: ReactNode; onBack?: () => void; right?: ReactNode }) {
  const navigate = useNavigate()
  const { t } = useT()
  const back = onBack ?? (() => navigate(-1))
  return (
    <header className="safe-top sticky top-0 z-30 border-b border-line bg-bg/92 backdrop-blur-xl">
      <div className="mx-auto flex h-12 max-w-lg items-center gap-1 px-2">
        <button
          onClick={back}
          aria-label={t('action.back')}
          className="flex h-10 w-10 items-center justify-center rounded-full text-fg active:bg-subtle"
        >
          <ChevronLeft size={22} strokeWidth={1.75} />
        </button>
        <div className="min-w-0 flex-1 truncate text-center text-[15px] font-medium tracking-[-0.01em]">{title}</div>
        <div className="flex h-10 w-10 items-center justify-center">{right}</div>
      </div>
    </header>
  )
}

export function PageTitle({ eyebrow, title }: { eyebrow?: string; title: string }) {
  return (
    <div className="px-5 pb-2 pt-6">
      {eyebrow && <p className="mb-1 text-[13px] text-muted">{eyebrow}</p>}
      <h1 className="text-[26px] font-semibold tracking-[-0.02em]">{title}</h1>
    </div>
  )
}

// Grayscale status: weight of fill encodes urgency. Solid = needs action, outline = waiting, faint = done.
const STATUS_STYLE: Record<Status, string> = {
  Submitted: 'border border-fg/25 text-fg',
  Triaged: 'border border-fg/25 text-fg',
  Assigned: 'bg-inverse text-inverse-fg',
  InProgress: 'bg-inverse text-inverse-fg',
  OnHold: 'border border-fg/25 text-muted',
  AwaitingApproval: 'bg-inverse text-inverse-fg',
  Resolved: 'bg-subtle text-fg border border-line',
  Closed: 'text-muted border border-line',
  Cancelled: 'text-muted border border-line',
  Rejected: 'text-muted border border-line',
  Duplicate: 'text-muted border border-line',
}

export function StatusChip({ status }: { status: Status }) {
  const { t } = useT()
  return (
    <span className={clsx('inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-[12px] font-medium', STATUS_STYLE[status])}>
      {t(`status.${status}` as never) || labelStatus(status)}
    </span>
  )
}

export function PriorityMark({ p }: { p: string }) {
  return <span className="token text-[12px] font-medium text-muted">{p}</span>
}

export function FlagMark({ flag }: { flag: 'I' | 'C' | 'P' }) {
  return (
    <span className="token inline-flex h-5 w-5 items-center justify-center rounded-full border border-fg/30 text-[11px] font-semibold" title="Work flag">
      {flag}
    </span>
  )
}

export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: ReactNode }) {
  return (
    <label className="block px-5 py-3">
      <span className="mb-2 flex items-baseline justify-between">
        <span className="text-[13px] font-medium text-muted">{label}</span>
        {hint && <span className="text-[12px] text-muted/80">{hint}</span>}
      </span>
      {children}
      {error && <span className="mt-1.5 block text-[13px] text-fg">{error}</span>}
    </label>
  )
}

const inputBase =
  'w-full rounded-md border border-line bg-surface px-4 py-3 text-[16px] text-fg placeholder:text-muted/60 focus:border-fg/40'

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={clsx(inputBase, props.className)} />
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={clsx(inputBase, 'appearance-none', props.className)} />
}

export function Segmented<T extends string>({ options, value, onChange, label }:
  { options: { value: T; label: ReactNode }[]; value: T; onChange: (v: T) => void; label?: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex rounded-md bg-subtle p-1">
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className="relative flex-1 rounded-[9px] px-2 py-2 text-[14px] font-medium text-muted"
        >
          {value === o.value && (
            <motion.span layoutId={`seg-${label ?? o.value}`} transition={spring} className="absolute inset-0 rounded-[9px] bg-inverse shadow-sm" />
          )}
          <span className={clsx('relative z-10', value === o.value && 'text-inverse-fg')}>{o.label}</span>
        </button>
      ))}
    </div>
  )
}

export function OptionRow({ selected, title, detail, onClick }: { selected?: boolean; title: string; detail?: string; onClick: () => void }) {
  return (
    <motion.button whileTap={{ scale: 0.99 }} onClick={onClick}
      className={clsx('flex w-full items-center justify-between gap-3 border-b border-line px-5 py-4 text-left', selected && 'bg-subtle')}>
      <span>
        <span className="block text-[15px] font-medium">{title}</span>
        {detail && <span className="mt-0.5 block text-[13px] text-muted">{detail}</span>}
      </span>
      {selected && <span className="h-2.5 w-2.5 rounded-full bg-inverse" />}
    </motion.button>
  )
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={clsx('animate-pulse rounded-md bg-subtle', className)} />
}

export function EmptyState({ title, body, action }: { title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="mx-5 my-10 rounded-lg border border-dashed border-line px-6 py-10 text-center">
      <p className="text-[16px] font-medium">{title}</p>
      {body && <p className="mx-auto mt-1.5 max-w-[34ch] text-[14px] leading-5 text-muted">{body}</p>}
      {action && <div className="mt-5 [&>button]:w-auto [&>button]:px-8">{action}</div>}
    </div>
  )
}

export function Fade({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      transition={{ ...spring, stiffness: 340, damping: 30 }}
      className={className}
    >
      {children}
    </motion.div>
  )
}

/** Ticket building blocks shared by the faculty and staff screens. */
import { clsx } from 'clsx'
import { ChevronRight, ImageOff, Loader2, Play, Plus, Star } from 'lucide-react'
import { useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../lib/api'
import { building, buildingDepartments, buildingName, category, categoryName, categoryParts } from '../lib/catalog'
import { PrepareError, checkVideo, preparePhoto } from '../lib/images'
import { LOCALE, useT, type Lang, type TFunc } from '../lib/i18n'
import type { Attachment, Comment, Ticket, TicketSummary, TimelineEvent } from '../lib/types'
import { Alert, Badge, Button, Dialog, StatusBadge, Textarea, errorMessage } from './ui'

const IST_DATE: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' }
const IST_TIME: Intl.DateTimeFormatOptions = { ...IST_DATE, hour: 'numeric', minute: '2-digit' }

export const fmtDate = (iso: string, lang: Lang = 'en') => new Date(iso).toLocaleDateString(LOCALE[lang], IST_DATE)
export const fmtTime = (iso: string, lang: Lang = 'en') => new Date(iso).toLocaleString(LOCALE[lang], IST_TIME)

export function ago(iso: string, t: TFunc, lang: Lang = 'en'): string {
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000))
  if (m < 1) return t('time.justNow')
  if (m < 60) return t('time.minutesAgo', { count: m })
  const h = Math.round(m / 60)
  if (h < 24) return t('time.hoursAgo', { count: h })
  const d = Math.round(h / 24)
  return d < 30 ? t('time.daysAgo', { count: d }) : fmtDate(iso, lang)
}

export function floorLabel(floor: string, t: TFunc): string {
  if (floor === 'Ground') return t('time.groundFloor')
  return /^\d+$/.test(floor) ? t('time.floor', { floor }) : floor
}

function departmentLabel(value: string, b: ReturnType<typeof building>, lang: Lang): string {
  if (!b) return value
  return buildingDepartments(b, lang).find((d) => d.value === value)?.label ?? value
}

export function placeText(ticket: Pick<TicketSummary, 'location'>, lang: Lang, t: TFunc): string {
  const l = ticket.location
  const b = building(l.building)
  if (l.outdoors) return [t('ticket.outdoors'), l.customLocation, departmentLabel(l.department ?? '', b, lang), l.landmark].filter(Boolean).join(', ')
  const name = l.customLocation ? l.customLocation : b ? buildingName(b, lang) : l.building
  const department = l.department ? `, ${departmentLabel(l.department, b, lang)}` : ''
  const floor = l.floor ? `, ${floorLabel(l.floor, t)}` : ''
  return `${name}${department}${floor}, ${l.room}`
}

function LocationDetails({ ticket, lang }: { ticket: Pick<TicketSummary, 'location'>; lang: Lang }) {
  const { t } = useT()
  const l = ticket.location
  const b = building(l.building)
  const place = l.customLocation ? l.customLocation : b ? buildingName(b, lang) : l.building
  const rows = [
    [l.customLocation ? t('ticket.buildingLocation') : t('ticket.building'), place],
    [b?.code === 'HOSTEL' ? t('ticket.hostelSection') : t('ticket.departmentArea'), departmentLabel(l.department ?? '', b, lang)],
    [t('ticket.floor'), l.floor ? floorLabel(l.floor, t) : ''],
    [t('ticket.roomArea'), l.room],
    [t('ticket.landmark'), l.landmark],
    [t('ticket.outdoors'), l.outdoors ? t('ticket.yes') : ''],
  ].filter(([, value]) => value)
  if (!rows.length) return null
  return (
    <div className="mt-3 rounded-md border border-line bg-subtle px-3.5 py-3">
      <p className="text-[13px] font-semibold uppercase tracking-wide text-muted">{t('ticket.location')}</p>
      <dl className="mt-1.5 grid gap-x-4 gap-y-1 text-[14px] sm:grid-cols-2">
        {rows.map(([label, value]) => (
          <div key={label} className="flex min-w-0 gap-1.5">
            <dt className="shrink-0 text-muted">{label}:</dt>
            <dd className="min-w-0 break-words">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

function subtypeText(c: ReturnType<typeof category>, subtype: string | null | undefined, lang: Lang): string {
  if (!subtype) return ''
  const base = c.subtypesEn.find((s) => subtype === s || subtype.startsWith(`${s}: `))
  if (!base) return subtype
  const label = categoryParts(c, lang).find((p) => p.value === base)?.label ?? base
  return subtype === base ? label : `${label}: ${subtype.slice(base.length + 2)}`
}

export function typeText(ticket: Pick<TicketSummary, 'categoryCode' | 'subtype'>, lang: Lang): string {
  const c = category(ticket.categoryCode)
  return `${categoryName(c, lang)}${ticket.subtype ? ` · ${subtypeText(c, ticket.subtype, lang)}` : ''}`
}

/** One ticket in a list. */
export function TicketRow({ ticket, to, extra }: { ticket: TicketSummary; to: string; extra?: React.ReactNode }) {
  const { lang, t } = useT()
  return (
    <Link to={to} className="flex items-center gap-3 border-b border-line px-4 py-3.5 last:border-b-0 hover:bg-subtle">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="token text-[13px] font-semibold">{ticket.token}</span>
          <StatusBadge status={ticket.status} />
          {ticket.impact === 'safety' && <Badge tone="bad">{t('impact.safety')}</Badge>}
          {extra}
        </div>
        <p className="mt-1 truncate text-[15px] font-medium">{ticket.title}</p>
        <p className="mt-0.5 truncate text-[13px] text-muted">{typeText(ticket, lang)} · {placeText(ticket, lang, t)} · {ago(ticket.createdAt, t, lang)}</p>
      </div>
      <ChevronRight size={18} className="shrink-0 text-muted" aria-hidden />
    </Link>
  )
}

export function TicketList({ children }: { children: React.ReactNode }) {
  return <div className="overflow-hidden rounded-lg border border-line bg-surface">{children}</div>
}

/** Token, status, title and place at the top of a ticket page. */
export function TicketSummaryCard({ ticket, children }: { ticket: Ticket; children?: React.ReactNode }) {
  const { lang, t } = useT()
  return (
    <section className="rounded-lg border border-line bg-surface p-4 md:p-5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="token rounded-md bg-subtle px-2.5 py-1 text-[18px] font-bold md:text-[20px]">{ticket.token}</span>
        <StatusBadge status={ticket.status} />
        {ticket.impact === 'safety' && <Badge tone="bad">{t('impact.safety')}</Badge>}
      </div>
      <h1 className="mt-3 text-[20px] font-semibold leading-snug md:text-[22px]">{ticket.title}</h1>
      <LocationDetails ticket={ticket} lang={lang} />
      <p className="mt-1 text-[14px] text-muted">{typeText(ticket, lang)}</p>
      {ticket.description && <p className="mt-3 whitespace-pre-line text-[15px] leading-6">{ticket.description}</p>}
      <p className="mt-3 text-[13px] text-muted">{t('ticket.reportedBy')} {ticket.reporterName} · {fmtTime(ticket.createdAt, lang)}</p>
      {children}
    </section>
  )
}

/** Five stars with the optional comment, shared by the faculty and staff views. */
export function RatingSummary({ stars, comment, createdAt }: { stars: number; comment?: string | null; createdAt?: string }) {
  const { lang, t } = useT()
  return (
    <div>
      <div className="flex items-center gap-1" aria-label={t('ticket.starsOutOf5', { stars })}>
        {[1, 2, 3, 4, 5].map((n) => (
          <Star key={n} size={18} className={n <= stars ? 'fill-current text-warn' : 'text-line'} aria-hidden />
        ))}
        <span className="ml-2 text-[14px] text-muted">{t('common.of5', { value: stars })}</span>
      </div>
      {comment && <p className="mt-2 whitespace-pre-line text-[14.5px]">{comment}</p>}
      {createdAt && <p className="mt-1 text-[12.5px] text-muted">{fmtDate(createdAt, lang)}</p>}
    </div>
  )
}

export function Timeline({ events }: { events: TimelineEvent[] }) {
  const { lang } = useT()
  return (
    <ol className="space-y-4">
      {[...events].reverse().map((e, i) => (
        <li key={e.id} className="flex gap-3">
          <span className={clsx('mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full', i === 0 ? 'bg-accent' : 'bg-line')} aria-hidden />
          <div className="min-w-0">
            <p className="text-[14.5px] font-medium">{e.action}</p>
            <p className="text-[13px] text-muted">
              {fmtTime(e.at, lang)} · {e.actor}{e.delegatedWorker ? ` (for ${e.delegatedWorker})` : ''}
            </p>
            {e.detail && <p className="mt-0.5 text-[13.5px]">{e.detail}</p>}
          </div>
        </li>
      ))}
    </ol>
  )
}

/** Photos and videos with a full-size viewer, and an upload button when allowed. */
export function Gallery({ ticket, canAdd, onChanged }: { ticket: Ticket; canAdd?: boolean; onChanged?: () => void }) {
  const { t } = useT()
  const [open, setOpen] = useState<Attachment | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const items = ticket.attachments

  async function add(files: FileList | null) {
    if (!files?.length) return
    setBusy(true); setError(null)
    try {
      for (const f of Array.from(files)) {
        if (f.type.startsWith('video/')) {
          const bad = checkVideo(f)
          if (bad) throw new PrepareError(bad)
          await api.uploadAttachment(ticket.id, f)
        } else {
          await api.uploadAttachment(ticket.id, await preparePhoto(f))
        }
      }
      onChanged?.()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
      if (input.current) input.current.value = ''
    }
  }

  if (!items.length && !canAdd) return null
  return (
    <div>
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5">
        {items.map((a) => (
          <button key={a.id} type="button" onClick={() => a.state === 'available' && setOpen(a)}
            className="relative aspect-square overflow-hidden rounded-md border border-line bg-subtle" aria-label={t('ticket.openPhoto', { name: a.name })}>
            {a.state === 'available' && a.url && a.kind === 'photo' && <img src={a.url} alt={a.name} loading="lazy" className="h-full w-full object-cover" />}
            {a.state === 'available' && a.kind === 'video' && <span className="flex h-full items-center justify-center"><Play size={26} /></span>}
            {a.state !== 'available' && (
              <span className="flex h-full flex-col items-center justify-center gap-1 p-2 text-center text-[11.5px] text-muted">
                {a.state === 'failed' ? <ImageOff size={18} /> : <Loader2 size={18} className="animate-spin" />}
                {a.state === 'failed' ? (a.failureReason ?? t('form.notAccepted')) : t('form.checking')}
              </span>
            )}
          </button>
        ))}
        {canAdd && items.filter((a) => a.state !== 'failed').length < 4 && (
          <button type="button" onClick={() => input.current?.click()} disabled={busy}
            className="flex aspect-square flex-col items-center justify-center gap-1 rounded-md border border-dashed border-line text-[13px] text-muted hover:bg-subtle">
            {busy ? <Loader2 size={20} className="animate-spin" /> : <Plus size={20} />}
            {t('ticket.addPhoto')}
          </button>
        )}
      </div>
      <input ref={input} type="file" accept="image/*,video/mp4,video/webm" multiple hidden onChange={(e) => void add(e.target.files)} />
      {error && <div className="mt-3"><Alert tone="bad">{error}</Alert></div>}
      <Dialog open={!!open} onClose={() => setOpen(null)} title={open?.name ?? ''} wide>
        {open?.kind === 'photo' && open.url && <img src={open.url} alt={open.name} className="max-h-[75vh] w-full rounded-md object-contain" />}
        {open?.kind === 'video' && open.url && <video src={open.url} controls autoPlay className="max-h-[75vh] w-full rounded-md" />}
      </Dialog>
    </div>
  )
}

/** Message thread. Staff can choose internal (never shown to faculty) or public. */
export function Messages({ comments, staff, onSend }: { comments: Comment[]; staff?: boolean; onSend: (body: string, internal: boolean) => Promise<void> }) {
  const { lang, t } = useT()
  const [body, setBody] = useState('')
  const [internal, setInternal] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function send(e: React.FormEvent) {
    e.preventDefault()
    if (!body.trim()) return
    setBusy(true); setError(null)
    try { await onSend(body.trim(), internal); setBody('') } catch (err) { setError(errorMessage(err)) } finally { setBusy(false) }
  }

  return (
    <div className="space-y-3">
      {comments.length === 0 && <p className="text-[14px] text-muted">{t('ticket.noMessages')}</p>}
      {comments.map((c) => (
        <div key={c.id} className={clsx('rounded-md border px-3.5 py-2.5', c.internal ? 'border-warn/30 bg-warn-soft' : 'border-line bg-subtle')}>
          <p className="whitespace-pre-line text-[14.5px]">{c.body}</p>
          <p className="mt-1 text-[12.5px] text-muted">{c.internal ? t('ticket.internalNotePrefix') : ''}{c.actor} · {fmtTime(c.at, lang)}</p>
        </div>
      ))}
      <form onSubmit={send} className="space-y-2">
        <Textarea rows={2} maxLength={2000} value={body} onChange={(e) => setBody(e.target.value)} aria-label={t('ticket.message')}
          placeholder={staff ? (internal ? t('ticket.internalNoteShort') : t('ticket.messageReporter')) : t('ticket.commentPlaceholder')} />
        <div className="flex flex-wrap items-center justify-between gap-2">
          {staff ? (
            <label className="flex items-center gap-2 text-[14px]">
              <input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} className="h-4 w-4 accent-[var(--c-accent)]" />
              {t('ticket.internalNote')}
            </label>
          ) : <span />}
          <Button type="submit" size="sm" loading={busy} disabled={!body.trim()}>{t('ticket.send')}</Button>
        </div>
        {error && <Alert tone="bad">{error}</Alert>}
      </form>
    </div>
  )
}

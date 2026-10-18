/** Ticket building blocks shared by the faculty and staff screens. */
import { clsx } from 'clsx'
import { ChevronRight, ImageOff, Loader2, MapPin, Play, Plus } from 'lucide-react'
import { useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../lib/api'
import { building, category } from '../lib/catalog'
import { PrepareError, checkVideo, preparePhoto } from '../lib/images'
import { useT } from '../lib/i18n'
import type { Attachment, Comment, Ticket, TicketSummary, TimelineEvent } from '../lib/types'
import { Alert, Badge, Button, Dialog, StatusBadge, Textarea, errorMessage } from './ui'

const IST_DATE: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' }
const IST_TIME: Intl.DateTimeFormatOptions = { ...IST_DATE, hour: 'numeric', minute: '2-digit' }

export const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('en-IN', IST_DATE)
export const fmtTime = (iso: string) => new Date(iso).toLocaleString('en-IN', IST_TIME)

export function ago(iso: string): string {
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000))
  if (m < 1) return 'just now'
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  const d = Math.round(h / 24)
  return d < 30 ? `${d} d ago` : fmtDate(iso)
}

export function placeText(t: Pick<TicketSummary, 'location'>, lang: 'en' | 'hi' = 'en'): string {
  const l = t.location
  if (l.outdoors) return l.landmark ? `Outdoors, ${l.landmark}` : 'Outdoors'
  const b = building(l.building)
  const name = b ? (lang === 'hi' ? b.nameHi : b.nameEn) : l.building
  const floor = l.floor ? (l.floor === 'Ground' ? ', Ground floor' : `, Floor ${l.floor}`) : ''
  return `${name}${floor}, ${l.room}`
}

export function typeText(t: Pick<TicketSummary, 'categoryCode' | 'subtype'>, lang: 'en' | 'hi' = 'en'): string {
  const c = category(t.categoryCode)
  return `${lang === 'hi' ? c.nameHi : c.nameEn}${t.subtype ? ` · ${t.subtype}` : ''}`
}

/** One ticket in a list. */
export function TicketRow({ ticket, to, extra }: { ticket: TicketSummary; to: string; extra?: React.ReactNode }) {
  const { lang } = useT()
  return (
    <Link to={to} className="flex items-center gap-3 border-b border-line px-4 py-3.5 last:border-b-0 hover:bg-subtle">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="token text-[13px] font-semibold">{ticket.token}</span>
          <StatusBadge status={ticket.status} />
          {ticket.impact === 'safety' && <Badge tone="bad">Safety</Badge>}
          {extra}
        </div>
        <p className="mt-1 truncate text-[15px] font-medium">{ticket.title}</p>
        <p className="mt-0.5 truncate text-[13px] text-muted">{typeText(ticket, lang)} · {placeText(ticket, lang)} · {ago(ticket.createdAt)}</p>
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
        {ticket.impact === 'safety' && <Badge tone="bad">Safety</Badge>}
      </div>
      <h1 className="mt-3 text-[20px] font-semibold leading-snug md:text-[22px]">{ticket.title}</h1>
      <p className="mt-1.5 flex items-start gap-1.5 text-[14px] text-muted"><MapPin size={15} className="mt-0.5 shrink-0" /> {placeText(ticket, lang)}</p>
      <p className="mt-1 text-[14px] text-muted">{typeText(ticket, lang)}</p>
      {ticket.description && <p className="mt-3 whitespace-pre-line text-[15px] leading-6">{ticket.description}</p>}
      <p className="mt-3 text-[13px] text-muted">{t('ticket.reportedBy')} {ticket.reporterName} · {fmtTime(ticket.createdAt)}</p>
      {children}
    </section>
  )
}

export function Timeline({ events }: { events: TimelineEvent[] }) {
  return (
    <ol className="space-y-4">
      {[...events].reverse().map((e, i) => (
        <li key={e.id} className="flex gap-3">
          <span className={clsx('mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full', i === 0 ? 'bg-accent' : 'bg-line')} aria-hidden />
          <div className="min-w-0">
            <p className="text-[14.5px] font-medium">{e.action}</p>
            <p className="text-[13px] text-muted">
              {fmtTime(e.at)} · {e.actor}{e.delegatedWorker ? ` (for ${e.delegatedWorker})` : ''}
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
            className="relative aspect-square overflow-hidden rounded-md border border-line bg-subtle" aria-label={`Open ${a.name}`}>
            {a.state === 'available' && a.url && a.kind === 'photo' && <img src={a.url} alt={a.name} loading="lazy" className="h-full w-full object-cover" />}
            {a.state === 'available' && a.kind === 'video' && <span className="flex h-full items-center justify-center"><Play size={26} /></span>}
            {a.state !== 'available' && (
              <span className="flex h-full flex-col items-center justify-center gap-1 p-2 text-center text-[11.5px] text-muted">
                {a.state === 'failed' ? <ImageOff size={18} /> : <Loader2 size={18} className="animate-spin" />}
                {a.state === 'failed' ? (a.failureReason ?? 'Not accepted') : 'Checking'}
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
  const { t } = useT()
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
      {comments.length === 0 && <p className="text-[14px] text-muted">No messages yet.</p>}
      {comments.map((c) => (
        <div key={c.id} className={clsx('rounded-md border px-3.5 py-2.5', c.internal ? 'border-warn/30 bg-warn-soft' : 'border-line bg-subtle')}>
          <p className="whitespace-pre-line text-[14.5px]">{c.body}</p>
          <p className="mt-1 text-[12.5px] text-muted">{c.internal ? 'Internal note · ' : ''}{c.actor} · {fmtTime(c.at)}</p>
        </div>
      ))}
      <form onSubmit={send} className="space-y-2">
        <Textarea rows={2} maxLength={2000} value={body} onChange={(e) => setBody(e.target.value)} aria-label="Message"
          placeholder={staff ? (internal ? 'Internal note (staff only)' : 'Message to the reporter') : t('ticket.commentPlaceholder')} />
        <div className="flex flex-wrap items-center justify-between gap-2">
          {staff ? (
            <label className="flex items-center gap-2 text-[14px]">
              <input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} className="h-4 w-4 accent-[var(--c-accent)]" />
              Internal note (not shown to the reporter)
            </label>
          ) : <span />}
          <Button type="submit" size="sm" loading={busy} disabled={!body.trim()}>{t('ticket.send')}</Button>
        </div>
        {error && <Alert tone="bad">{error}</Alert>}
      </form>
    </div>
  )
}

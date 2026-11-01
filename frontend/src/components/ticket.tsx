/** Ticket building blocks shared by the faculty and staff screens. */
import { clsx } from 'clsx'
import { ChevronRight, Download, FileText, ImageOff, ImagePlus, Languages, Loader2, Play, Plus, Star } from 'lucide-react'
import { useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../App'
import { api } from '../lib/api'
import { detectLang, translateText } from '../lib/translate'
import { building, buildingDepartments, buildingName, category, categoryName, categoryParts } from '../lib/catalog'
import { PrepareError, checkVideo, preparePhoto } from '../lib/images'
import { LOCALE, useT, type Lang, type TFunc } from '../lib/i18n'
import type { Attachment, Comment, Impact, Ticket, TicketSummary, TimelineEvent } from '../lib/types'
import { CameraButton } from './CameraCapture'
import { LanguageButtons } from './LanguageButtons'
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
  if (floor === 'Terrace') return t('time.terrace')
  return /^\d+$/.test(floor) ? t('time.floor', { floor }) : floor
}

const SEVERITY_TONE = { red: 'bad', orange: 'warn', green: 'ok' } as const
export const SEVERITY_DOT = { red: 'bg-bad', orange: 'bg-warn', green: 'bg-ok' } as const

/** The reporter's red, orange or green severity, colour-coded everywhere it appears. */
export function SeverityBadge({ impact }: { impact: Impact }) {
  const { t } = useT()
  return (
    <Badge tone={SEVERITY_TONE[impact]}>
      <span className={clsx('mr-1.5 inline-block h-2 w-2 rounded-full', SEVERITY_DOT[impact])} aria-hidden />
      {t(`impact.${impact}`)}
    </Badge>
  )
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

type TranslationMap = TicketSummary['translations']

/**
 * Text someone typed, shown in the reader's language when a machine translation exists,
 * with a link back to the original. Without a translation the original is shown as it is.
 */
export function Translated({ text, map }: { text: string | null | undefined; map?: TranslationMap }) {
  const { lang, t } = useT()
  const { user } = useAuth()
  const [original, setOriginal] = useState(false)
  const [asked, setAsked] = useState<{ lang: Lang; text: string } | null>(null)
  const [state, setState] = useState<'idle' | 'busy' | 'failed'>('idle')
  if (!text) return null
  const translated = map?.[text]?.[lang] ?? (asked?.lang === lang ? asked.text : undefined)
  const source = detectLang(text)
  if (!translated || translated === text) {
    // Only the facility manager translates, and only text written in another language.
    if (user?.role !== 'facility_manager' || !source || source === lang) return <>{text}</>
    const ask = async (e: React.MouseEvent) => {
      e.preventDefault(); e.stopPropagation()
      setState('busy')
      try {
        const r = await translateText(text, lang)
        if (r.ok) { setAsked({ lang, text: r.text }); setState('idle') } else setState('failed')
      } catch { setState('failed') }
    }
    return (
      <>
        {text}
        <button type="button" onClick={(e) => void ask(e)} disabled={state === 'busy'}
          className="ml-2 inline-flex items-center gap-1 whitespace-nowrap align-baseline text-[12px] font-normal text-accent hover:underline disabled:opacity-60">
          {state === 'busy' ? <Loader2 size={12} className="animate-spin" aria-hidden /> : <Languages size={12} aria-hidden />}
          {state === 'busy' ? t('translate.working') : state === 'failed' ? t('translate.retry') : t('translate.translate')}
        </button>
      </>
    )
  }
  return (
    <>
      {original ? text : translated}
      <button type="button" onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOriginal((v) => !v) }}
        className="ml-2 whitespace-nowrap align-baseline text-[12px] font-normal text-accent hover:underline">
        {original ? t('translate.showTranslation') : t('translate.showOriginal')}
      </button>
    </>
  )
}

/** The translated text, or the original, as a plain string (for one-line lists). */
export function translatedText(text: string, map: TranslationMap, lang: Lang): string {
  return map?.[text]?.[lang] ?? text
}

/** One ticket in a list. Staff lists pass showReporter so they can see who raised it. */
export function TicketRow({ ticket, to, extra, showReporter }: { ticket: TicketSummary; to: string; extra?: React.ReactNode; showReporter?: boolean }) {
  const { lang, t } = useT()
  return (
    <Link to={to} className="flex items-center gap-3 border-b border-line px-4 py-3.5 last:border-b-0 hover:bg-subtle">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="token text-[13px] font-semibold">{ticket.token}</span>
          <StatusBadge status={ticket.status} />
          <SeverityBadge impact={ticket.impact} />
          {extra}
        </div>
        <p className="mt-1 truncate text-[15px] font-medium">{translatedText(ticket.title, ticket.translations, lang)}</p>
        <p className="mt-0.5 truncate text-[13px] text-muted">{typeText(ticket, lang)} · {placeText(ticket, lang, t)} · {ago(ticket.createdAt, t, lang)}</p>
        {showReporter && <p className="mt-0.5 truncate text-[12.5px] text-muted">{t('ticket.reportedBy')} {ticket.reporterName}</p>}
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
        <SeverityBadge impact={ticket.impact} />
      </div>
      <h1 className="mt-3 text-[20px] font-semibold leading-snug md:text-[22px]"><Translated text={ticket.title} map={ticket.translations} /></h1>
      <LocationDetails ticket={ticket} lang={lang} />
      <p className="mt-1 text-[14px] text-muted">{typeText(ticket, lang)}</p>
      {ticket.description && <p className="mt-3 whitespace-pre-line text-[15px] leading-6"><Translated text={ticket.description} map={ticket.translations} /></p>}
      <p className="mt-3 text-[13px] text-muted">{t('ticket.reportedBy')} {ticket.reporterName} · {fmtTime(ticket.createdAt, lang)}</p>
      {children}
    </section>
  )
}

/** Five stars with the optional comment, shared by the faculty and staff views. */
export function RatingSummary({ stars, comment, createdAt, translations }: { stars: number; comment?: string | null; createdAt?: string; translations?: TranslationMap }) {
  const { lang, t } = useT()
  return (
    <div>
      <div className="flex items-center gap-1" aria-label={t('ticket.starsOutOf5', { stars })}>
        {[1, 2, 3, 4, 5].map((n) => (
          <Star key={n} size={18} className={n <= stars ? 'fill-current text-warn' : 'text-line'} aria-hidden />
        ))}
        <span className="ml-2 text-[14px] text-muted">{t('common.of5', { value: stars })}</span>
      </div>
      {comment && <p className="mt-2 whitespace-pre-line text-[14.5px]"><Translated text={comment} map={translations} /></p>}
      {createdAt && <p className="mt-1 text-[12.5px] text-muted">{fmtDate(createdAt, lang)}</p>}
    </div>
  )
}

export function Timeline({ events, translations }: { events: TimelineEvent[]; translations?: TranslationMap }) {
  const { lang } = useT()
  return (
    <ol className="space-y-4">
      {[...events].reverse().map((e, i) => (
        <li key={e.id} className="flex gap-3">
          <span className={clsx('mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full', i === 0 ? 'bg-accent' : 'bg-line')} aria-hidden />
          <div className="min-w-0">
            <p className="text-[14.5px] font-medium">{translatedText(e.action, translations, lang)}</p>
            <p className="text-[13px] text-muted">
              {fmtTime(e.at, lang)} · {e.actor}{e.delegatedWorker ? ` (for ${e.delegatedWorker})` : ''}
            </p>
            {e.detail && <p className="mt-0.5 text-[13.5px]"><Translated text={e.detail} map={translations} /></p>}
          </div>
        </li>
      ))}
    </ol>
  )
}

const MAX_PHOTOS = 3
const MAX_VIDEOS = 1

/**
 * The reporter's photos and videos with a full-size viewer. Only the reporter adds them
 * (camera or file); staff see them read-only and add their own files under Documents.
 * The server enforces the same rule.
 */
export function Gallery({ ticket, canAdd, onChanged }: { ticket: Ticket; canAdd?: boolean; onChanged?: () => void }) {
  const { t } = useT()
  const [open, setOpen] = useState<Attachment | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const items = ticket.attachments.filter((a) => a.kind !== 'document')
  const live = items.filter((a) => a.state !== 'failed')
  const photos = live.filter((a) => a.kind === 'photo').length
  const videos = live.filter((a) => a.kind === 'video').length
  const full = photos >= MAX_PHOTOS && videos >= MAX_VIDEOS

  async function add(files: File[]) {
    if (!files.length) return
    setBusy(true); setError(null)
    let p = photos, v = videos
    try {
      for (const f of files) {
        if (f.type.startsWith('video/')) {
          if (v >= MAX_VIDEOS) throw new PrepareError('form.oneVideo')
          const bad = checkVideo(f)
          if (bad) throw new PrepareError(bad)
          await api.uploadAttachment(ticket.id, f)
          v++
        } else {
          if (p >= MAX_PHOTOS) throw new PrepareError('form.tooManyPhotos')
          await api.uploadAttachment(ticket.id, await preparePhoto(f))
          p++
        }
      }
    } catch (e) {
      setError(e instanceof PrepareError ? t(e.key) : errorMessage(e))
    } finally {
      setBusy(false)
      onChanged?.()
    }
  }

  return (
    <div>
      {!canAdd && <p className="mb-3 text-[13px] text-muted">{items.length ? t('ticket.photosReadOnly') : t('ticket.noPhotos')}</p>}
      {items.length > 0 && (
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5">
          {items.map((a) => (
            <figure key={a.id} className="min-w-0">
              <button type="button" onClick={() => a.state === 'available' && setOpen(a)}
                className="relative aspect-square w-full overflow-hidden rounded-md border border-line bg-subtle" aria-label={t('ticket.openPhoto', { name: a.name })}>
                {a.state === 'available' && a.url && a.kind === 'photo' && <img src={a.url} alt={a.name} loading="lazy" className="h-full w-full object-cover" />}
                {a.state === 'available' && a.kind === 'video' && <span className="flex h-full items-center justify-center"><Play size={26} /></span>}
                {a.state !== 'available' && (
                  <span className="flex h-full flex-col items-center justify-center gap-1 p-2 text-center text-[11.5px] text-muted">
                    {a.state === 'failed' ? <ImageOff size={18} /> : <Loader2 size={18} className="animate-spin" />}
                    {a.state === 'failed' ? (a.failureReason ?? t('form.notAccepted')) : t('form.checking')}
                  </span>
                )}
              </button>
              <figcaption className="mt-1 truncate text-[11.5px] text-muted">{t('ticket.uploadedBy', { name: a.uploadedBy })}</figcaption>
            </figure>
          ))}
        </div>
      )}
      {canAdd && (
        <div className={clsx('flex flex-wrap items-center gap-2', items.length > 0 && 'mt-3')}>
          <CameraButton disabled={busy || full} allowVideo={videos < MAX_VIDEOS} onFiles={(f) => void add(f)} />
          <Button variant="secondary" disabled={busy || full} onClick={() => input.current?.click()}>
            {busy ? <Loader2 size={17} className="animate-spin" /> : <ImagePlus size={17} />} {t('form.choosePhoto')}
          </Button>
          <span className="text-[12.5px] text-muted">{t('form.photosHint')}</span>
        </div>
      )}
      <input ref={input} type="file" accept="image/*,video/mp4,video/webm,video/quicktime" multiple hidden
        onChange={(e) => { const f = Array.from(e.target.files ?? []); e.target.value = ''; void add(f) }} />
      {error && <div className="mt-3"><Alert tone="bad">{error}</Alert></div>}
      <Dialog open={!!open} onClose={() => setOpen(null)} title={open?.name ?? ''} wide>
        {open?.kind === 'photo' && open.url && <img src={open.url} alt={open.name} className="max-h-[75vh] w-full rounded-md object-contain" />}
        {open?.kind === 'video' && open.url && <video src={open.url} controls autoPlay playsInline className="max-h-[75vh] w-full rounded-md" />}
      </Dialog>
    </div>
  )
}

const DOCUMENT_ACCEPT = [
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.jpg', '.jpeg', '.png', '.webp',
  'application/pdf', 'application/msword', 'application/vnd.ms-excel', 'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain', 'image/jpeg', 'image/png', 'image/webp',
].join(',')
const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024

/** Staff documents (quotes, approvals, reports). The server never returns them to faculty. */
export function Documents({ ticket, canAdd, onChanged }: { ticket: Ticket; canAdd?: boolean; onChanged?: () => void }) {
  const { t, lang } = useT()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const docs = ticket.attachments.filter((a) => a.kind === 'document')

  async function add(files: FileList | null) {
    if (!files?.length) return
    setBusy(true); setError(null)
    try {
      for (const f of Array.from(files)) {
        if (f.size > MAX_DOCUMENT_BYTES) throw new PrepareError('media.documentTooLarge')
        await api.uploadAttachment(ticket.id, f, undefined, 'document')
      }
      onChanged?.()
    } catch (e) {
      setError(e instanceof PrepareError ? t(e.key) : errorMessage(e))
    } finally {
      setBusy(false)
      if (input.current) input.current.value = ''
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-[13px] text-muted">{t('ticket.documentsHint')}</p>
      {docs.length === 0 && <p className="text-[14px] text-muted">{t('ticket.noDocuments')}</p>}
      {docs.length > 0 && (
        <ul className="divide-y divide-line rounded-md border border-line">
          {docs.map((a) => (
            <li key={a.id} className="flex items-center gap-3 px-3.5 py-2.5">
              <FileText size={18} className="shrink-0 text-muted" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px]">{a.name}</span>
                <span className="block truncate text-[12px] text-muted">
                  {t('ticket.uploadedBy', { name: a.uploadedBy })}{a.uploadedAt ? ` · ${fmtTime(a.uploadedAt, lang)}` : ''}
                </span>
              </span>
              {a.state === 'available' && a.url
                ? <a href={a.url} download className="inline-flex items-center gap-1 text-[13.5px] text-accent"><Download size={15} aria-hidden /> {t('ticket.download')}</a>
                : <span className="text-[12.5px] text-muted">{a.state === 'failed' ? (a.failureReason ?? t('form.notAccepted')) : t('form.checking')}</span>}
            </li>
          ))}
        </ul>
      )}
      {canAdd && (
        <Button size="sm" variant="secondary" loading={busy} onClick={() => input.current?.click()}>
          <Plus size={16} /> {t('ticket.addDocument')}
        </Button>
      )}
      <input ref={input} type="file" accept={DOCUMENT_ACCEPT} multiple hidden onChange={(e) => void add(e.target.files)} />
      {error && <Alert tone="bad">{error}</Alert>}
    </div>
  )
}

/**
 * Staff message thread. Seen and written only by the facility manager, institute
 * management, the principal and Team OSSC; the server never sends it to faculty.
 */
export function Messages({ comments, onSend, translations }: { comments: Comment[]; onSend: (body: string) => Promise<void>; translations?: TranslationMap }) {
  const { lang, t } = useT()
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function send(e: React.FormEvent) {
    e.preventDefault()
    if (!body.trim()) return
    setBusy(true); setError(null)
    try { await onSend(body.trim()); setBody('') } catch (err) { setError(errorMessage(err)) } finally { setBusy(false) }
  }

  return (
    <div className="space-y-3">
      <p className="text-[13px] text-muted">{t('ticket.notesOnly')}</p>
      {comments.length === 0 && <p className="text-[14px] text-muted">{t('ticket.noMessages')}</p>}
      {comments.map((c) => (
        <div key={c.id} className="rounded-md border border-line bg-subtle px-3.5 py-2.5">
          <p className="whitespace-pre-line text-[14.5px]"><Translated text={c.body} map={translations} /></p>
          <p className="mt-1 text-[12.5px] text-muted">{c.actor} · {fmtTime(c.at, lang)}</p>
        </div>
      ))}
      <form onSubmit={send} className="space-y-2">
        <Textarea rows={2} maxLength={2000} value={body} onChange={(e) => setBody(e.target.value)} aria-label={t('ticket.message')}
          placeholder={t('ticket.messagePlaceholder')} />
        <LanguageButtons value={body} maxLength={2000} onChange={setBody} />
        <div className="flex justify-end">
          <Button type="submit" size="sm" loading={busy} disabled={!body.trim()}>{t('ticket.send')}</Button>
        </div>
        {error && <Alert tone="bad">{error}</Alert>}
      </form>
    </div>
  )
}

import { useNavigate } from 'react-router-dom'
import type { Ticket } from '../lib/types'
import { StatusChip, FlagMark, Row } from './ui'
import { category, localName, localSubtypes } from '../lib/api'
import { useT } from '../lib/i18n'

export function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.round(diff / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} hr ago`
  const d = Math.round(h / 24)
  if (d < 30) return `${d} day${d > 1 ? 's' : ''} ago`
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
}

export function locationLine(t: Ticket, lang: string): string {
  const l = t.location
  if (l.outdoors) return l.landmark ? `Outdoors · ${l.landmark}` : 'Outdoors'
  const b = localName({ nameEn: `Block ${l.building}`, nameHi: `ब्लॉक ${l.building}`, nameKn: `ಬ್ಲಾಕ್ ${l.building}` }, lang)
  return `${b} · ${l.floor === 'Ground' ? 'Ground' : `Floor ${l.floor}`} · ${l.room}`
}

export default function TicketRow({ ticket }: { ticket: Ticket }) {
  const nav = useNavigate()
  const { lang } = useT()
  const cat = category(ticket.categoryCode)
  const sub = ticket.subtype
    ? (localSubtypes(cat, lang)[cat.subtypesEn.indexOf(ticket.subtype)] ?? ticket.subtype)
    : undefined
  return (
    <Row
      title={ticket.title}
      detail={
        <span className="flex flex-wrap items-center gap-x-1.5">
          <span className="token">{ticket.token}</span>
          <span aria-hidden>·</span>
          <span>{localName(cat, lang)}{sub ? ` · ${sub}` : ''}</span>
          <span aria-hidden>·</span>
          <span>{locationLine(ticket, lang)}</span>
        </span>
      }
      right={
        <span className="flex shrink-0 flex-col items-end gap-1.5">
          <StatusChip status={ticket.status} />
          <span className="flex items-center gap-1.5 text-[11.5px] text-muted">
            {ticket.flag && <FlagMark flag={ticket.flag} />}
            {relTime(ticket.createdAt)}
          </span>
        </span>
      }
      onClick={() => nav(`/t/${ticket.id}`)}
    />
  )
}

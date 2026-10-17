import { motion } from 'framer-motion'
import { useNavigate } from 'react-router-dom'
import type { Ticket } from '../lib/types'
import { StatusChip, FlagMark, spring } from './ui'
import { category } from '../lib/api'
import { useT, type TKey } from '../lib/i18n'

const IMPACT_KEY: Record<Ticket['impact'], TKey> = {
  safety: 'form.impact.safety',
  class_interrupted: 'form.impact.class',
  multiple_areas: 'form.impact.multiple',
  routine: 'form.impact.routine',
}

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

export function locationLine(t: Ticket): string {
  const l = t.location
  if (l.outdoors) return l.landmark ? `Outdoors · ${l.landmark}` : 'Outdoors'
  return `Block ${l.building} · ${l.floor === 'Ground' ? 'Ground' : `Floor ${l.floor}`} · ${l.room}`
}

export default function TicketRow({ ticket }: { ticket: Ticket }) {
  const nav = useNavigate()
  const { t, lang } = useT()
  const cat = category(ticket.categoryCode)
  return (
    <motion.button
      whileTap={{ scale: 0.985 }}
      transition={spring}
      onClick={() => nav(`/t/${ticket.id}`)}
      className="hairline-b block w-full px-5 py-4 text-left"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-[15px] font-medium tracking-[-0.01em]">{ticket.title}</p>
          <p className="token mt-1 text-[12.5px] text-muted">
            {ticket.token}
            <span className="mx-1.5 font-sans">·</span>
            {lang === 'hi' ? cat.nameHi : cat.nameEn}
            {ticket.subtype && <span className="font-sans"> · {ticket.subtype}</span>}
          </p>
          <p className="mt-1 truncate text-[13px] text-muted">{locationLine(ticket)}</p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          <StatusChip status={ticket.status} />
          <span className="flex items-center gap-1.5">
            {ticket.flag && <FlagMark flag={ticket.flag} />}
            <span className="text-[12px] text-muted">{relTime(ticket.createdAt)}</span>
          </span>
        </div>
      </div>
      {ticket.impact === 'safety' && (
        <p className="mt-2 inline-block rounded border border-fg/30 px-2 py-0.5 text-[12px] font-medium">{t(IMPACT_KEY.safety)}</p>
      )}
    </motion.button>
  )
}

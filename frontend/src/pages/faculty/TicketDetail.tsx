import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { BadgeCheck, ImageOff } from 'lucide-react'
import { api } from '../../lib/api'
import { useAuth } from '../../App'
import { useT } from '../../lib/i18n'
import { useSwipeBack } from '../../lib/hooks'
import { Button, NavBar, Skeleton, spring } from '../../components/ui'
import { locationLine } from '../../components/TicketRow'
import { TokenHero } from './Receipt'
import { category, labelStatus } from '../../lib/api'
import type { Ticket } from '../../lib/types'

export default function TicketDetail() {
  const { id } = useParams()
  const { user } = useAuth()
  const { t } = useT()
  const swipe = useSwipeBack()
  const [ticket, setTicket] = useState<Ticket | null | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [disputing, setDisputing] = useState(false)
  const [reason, setReason] = useState('')

  useEffect(() => {
    let live = true
    if (id) api.getTicket(id).then((tk) => live && setTicket(tk))
    return () => { live = false }
  }, [id])

  if (ticket === undefined) {
    return <div><NavBar title="" /><div className="space-y-4 px-5 pt-6"><Skeleton className="h-28" /><Skeleton className="h-40" /></div></div>
  }
  if (ticket === null) {
    return <div><NavBar title={t('nav.track')} /><p className="px-5 pt-8 text-[15px] text-muted">{t('error.notFound')}</p></div>
  }

  const cat = category(ticket.categoryCode)
  const isMine = user?.id === ticket.reporterId
  const publicEvents = ticket.events

  async function verify() {
    if (!user) return
    setBusy(true)
    const tk = await api.verify(ticket!.id, user)
    setTicket(tk); setBusy(false)
  }
  async function dispute() {
    if (!user || !reason.trim()) return
    setBusy(true)
    const tk = await api.dispute(ticket!.id, user, reason.trim())
    setTicket(tk); setBusy(false); setDisputing(false); setReason('')
  }

  return (
    <div {...swipe} className="mx-auto min-h-dvh max-w-lg">
      <NavBar title={labelStatus(ticket.status)} />
      <TokenHero ticket={ticket} />

      <div className="px-5 pt-6">
        <h2 className="text-[19px] font-semibold tracking-[-0.02em]">{ticket.title}</h2>
        <p className="mt-1 text-[13.5px] text-muted">{locationLine(ticket)} · {cat.nameEn.toLowerCase()}{ticket.subtype ? ` · ${ticket.subtype.toLowerCase()}` : ''}</p>
        {ticket.description && <p className="mt-3 max-w-[62ch] text-[14.5px] leading-6">{ticket.description}</p>}
        <p className="mt-3 text-[12.5px] text-muted">Reported by {ticket.reporterName} · {new Date(ticket.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'long' })}</p>
      </div>

      <div className="px-5">
        {ticket.status === 'Resolved' && !ticket.verifiedByReporter && (
          <div className="mt-5 rounded-lg border border-line p-4">
            <p className="text-[14px] font-medium">Reported as fixed</p>
            <p className="mt-1 text-[13.5px] leading-5 text-muted">Check the {cat.nameEn.toLowerCase()} work at {locationLine(ticket)}. If it is not right, tell us what is still wrong.</p>
            <div className="mt-4 flex gap-3">
              <Button onClick={verify} loading={busy}>{t('detail.verify')}</Button>
              <Button variant="outline" className="max-w-44 flex-none" onClick={() => setDisputing((d) => !d)}>{t('detail.dispute')}</Button>
            </div>
            <AnimatePresence>
              {disputing && (
                <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
                  <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} placeholder="What is still wrong?"
                    className="mt-3 w-full resize-none rounded-md border border-line bg-surface px-4 py-3 text-[15px] focus:border-fg/40" />
                  <Button variant="outline" onClick={dispute} disabled={!reason.trim() || busy}>Send to facilities</Button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )}
        {ticket.verifiedByReporter && (
          <p className="mt-5 flex items-center gap-2 rounded-lg border border-line px-4 py-3.5 text-[14px]">
            <BadgeCheck size={17} /> {t('detail.verified')}
          </p>
        )}

        <p className="mt-8 mb-1 text-[13px] font-medium text-muted">{t('detail.timeline')}</p>
        {ticket.nextUpdateDue && !['Closed', 'Resolved'].includes(ticket.status) && (
          <p className="mb-2 text-[13px] text-muted">{t('detail.nextUpdate')}: {new Date(ticket.nextUpdateDue).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}</p>
        )}
        <ol className="relative ml-1.5 border-l border-line pt-2">
          {publicEvents.map((e, i) => (
            <motion.li key={e.id} initial={i === publicEvents.length - 1 ? { opacity: 0, y: 8 } : false} animate={{ opacity: 1, y: 0 }} transition={spring}
              className="relative pb-6 pl-6">
              <span className={`absolute -left-[5px] top-1.5 h-2.5 w-2.5 rounded-full ${i === 0 ? 'bg-inverse' : 'border-2 border-fg bg-bg'}`} />
              <p className="text-[14.5px] font-medium leading-5">{plain(e.action)}</p>
              <p className="mt-0.5 text-[12.5px] text-muted">
                {new Date(e.at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}
                {e.detail ? ` · ${e.detail}` : ''}
              </p>
            </motion.li>
          ))}
        </ol>

        {ticket.attachments.length > 0 && (
          <>
            <p className="mb-2 mt-2 text-[13px] font-medium text-muted">Evidence</p>
            <div className="mb-6 flex gap-3 overflow-x-auto pb-2">
              {ticket.attachments.map((a) => a.dataUrl
                ? <img key={a.id} src={a.dataUrl} alt={a.name} className="h-24 w-24 shrink-0 rounded-md object-cover" />
                : <div key={a.id} className="flex h-24 w-24 shrink-0 flex-col items-center justify-center gap-1 rounded-md border border-dashed border-line text-muted"><ImageOff size={16} /><span className="px-2 text-center text-[10.5px] leading-3">{a.name}</span></div>)}
            </div>
          </>
        )}
        {!isMine && <p className="pb-8 text-[13px] text-muted">This ticket belongs to another reporter.</p>}
      </div>
    </div>
  )
}

function plain(action: string): string {
  const map: Record<string, string> = {
    Submitted: 'Your report was received',
    Triaged: 'Facilities reviewed it',
    Assigned: 'A worker was assigned',
    Accepted: 'The worker accepted the job',
    'In progress': 'Work started',
    Resolved: 'Work finished',
    'Verified and closed': 'Verified and closed',
    'Disputed — reopened to triage': 'You flagged it as not fixed — back with facilities',
  }
  return map[action] ?? action
}

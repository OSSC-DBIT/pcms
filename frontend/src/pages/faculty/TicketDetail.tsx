import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { motion } from 'framer-motion'
import { BadgeCheck, ImageOff } from 'lucide-react'
import { api, category, localName } from '../../lib/api'
import { useAuth } from '../../App'
import { useT } from '../../lib/i18n'
import { useSwipeBack } from '../../lib/hooks'
import { Banner, Button, Card, Fade, NavBar, SectionLabel, Skeleton, spring } from '../../components/ui'
import { locationLine } from '../../components/TicketRow'
import { TokenHero } from './Receipt'
import type { Ticket } from '../../lib/types'

export default function TicketDetail() {
  const { id } = useParams()
  const { user } = useAuth()
  const { t, lang } = useT()
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
    return <div {...swipe} className="mx-auto min-h-dvh max-w-lg"><NavBar title="" /><div className="space-y-3 px-4 pt-6"><Skeleton className="h-36" /><Skeleton className="h-48" /></div></div>
  }
  if (ticket === null) {
    return <div className="mx-auto min-h-dvh max-w-lg"><NavBar title={t('nav.track')} /><p className="px-4 pt-8 text-[15px] text-muted">{t('empty.tickets')}</p></div>
  }

  const cat = category(ticket.categoryCode)

  async function verify() {
    if (!user) return
    setBusy(true)
    setTicket(await api.verify(ticket!.id, user))
    setBusy(false)
  }
  async function dispute() {
    if (!user || !reason.trim()) return
    setBusy(true)
    setTicket(await api.dispute(ticket!.id, user, reason.trim()))
    setBusy(false); setDisputing(false); setReason('')
  }

  return (
    <Fade {...swipe} className="mx-auto min-h-dvh max-w-lg pb-12">
      <NavBar title={t('app.name')} />
      <TokenHero ticket={ticket} />

      <div className="px-4 pt-6">
        <h2 className="balance text-[20px] font-bold tracking-[-0.02em]">{ticket.title}</h2>
        <p className="mt-1 text-[13.5px] text-muted">{locationLine(ticket, lang)} · {localName(cat, lang)}{ticket.subtype ? ` · ${ticket.subtype}` : ''}</p>
        {ticket.description && <p className="pretty mt-3 max-w-[62ch] text-[15px] leading-6">{ticket.description}</p>}
        <p className="mt-3 text-[12.5px] text-muted">Reported {new Date(ticket.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'long' })}</p>
      </div>

      {ticket.status === 'Resolved' && !ticket.verifiedByReporter && (
        <Card className="mx-4 mt-6 p-4">
          <p className="text-[15px] font-semibold">{t('detail.reportedAsFixed')}</p>
          <p className="pretty mt-1 text-[13.5px] leading-5 text-muted">Check the work at {locationLine(ticket, lang)}. If it is not right, say what is still wrong.</p>
          <div className="mt-4 flex gap-3">
            <Button onClick={verify} loading={busy}>{t('detail.verify')}</Button>
            <Button variant="secondary" className="max-w-40 flex-none" onClick={() => setDisputing((d) => !d)}>{t('detail.dispute')}</Button>
          </div>
          {disputing && (
            <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} transition={spring} className="overflow-hidden">
              <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} placeholder="What is still wrong?" aria-label="Dispute reason"
                className="mt-3 w-full resize-none rounded-[11px] border border-line bg-surface px-3.5 py-3 text-[16px] leading-6 focus:border-fg/50" />
              <Button variant="secondary" onClick={dispute} disabled={!reason.trim() || busy}>Send to facilities</Button>
            </motion.div>
          )}
        </Card>
      )}
      {ticket.verifiedByReporter && (
        <div className="px-4 pt-6"><Banner><span className="mr-1.5 inline-flex translate-y-[2px]"><BadgeCheck size={14} /></span>'Verified and closed.'</Banner></div>
      )}

      <SectionLabel>{t('detail.timeline')}</SectionLabel>
      <Card className="mx-4 px-4 py-2">
        <ol className="relative ml-2 border-l border-line">
          {ticket.events.map((e, i) => (
            <motion.li key={e.id} initial={i === ticket.events.length - 1 ? { opacity: 0, y: 8 } : false} animate={{ opacity: 1, y: 0 }} transition={spring}
              className="relative pb-5 pl-5 last:pb-2">
              <span className={`absolute -left-[5px] top-1.5 h-2.5 w-2.5 rounded-full ${i === 0 ? 'bg-inverse' : 'border-2 border-fg bg-surface'}`} />
              <p className="text-[14.5px] font-semibold leading-5">{plain(e.action)}</p>
              <p className="mt-0.5 text-[12.5px] text-muted">
                {new Date(e.at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}
                {e.detail ? ` · ${e.detail}` : ''}
              </p>
            </motion.li>
          ))}
        </ol>
      </Card>

      {ticket.nextUpdateDue && !['Closed', 'Resolved'].includes(ticket.status) && (
        <div className="px-4 pt-4">
          <Banner>{t('detail.nextUpdate')}: {new Date(ticket.nextUpdateDue).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}</Banner>
        </div>
      )}

      {ticket.attachments.length > 0 && (
        <>
          <SectionLabel>Evidence</SectionLabel>
          <div className="flex gap-3 overflow-x-auto px-4 pb-2">
            {ticket.attachments.map((a) => a.dataUrl
              ? <img key={a.id} src={a.dataUrl} alt={a.name} className="h-24 w-24 shrink-0 rounded-[13px] object-cover shadow-[0_1px_2px_rgba(0,0,0,0.08)]" />
              : <div key={a.id} className="flex h-24 w-24 shrink-0 flex-col items-center justify-center gap-1 rounded-[13px] border border-dashed border-line text-muted"><ImageOff size={16} /><span className="px-2 text-center text-[10.5px] leading-3">{a.name}</span></div>)}
          </div>
        </>
      )}
    </Fade>
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

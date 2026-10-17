import { useNavigate, useParams } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { Printer, Check } from 'lucide-react'
import { api, category, labelStatus } from '../../lib/api'
import { useT } from '../../lib/i18n'
import { Button, NavBar } from '../../components/ui'
import type { Ticket } from '../../lib/types'

export function TokenHero({ ticket }: { ticket: Ticket }) {
  return (
    <section aria-label="Ticket token" className="mx-5 mt-6 rounded-lg border border-dashed border-fg/40 px-5 py-6 text-center">
      <p className="text-[12px] font-medium text-muted">TOKEN</p>
      <p className="token mt-2 text-[30px] font-semibold tracking-[-0.03em]">{ticket.token}</p>
      <p className="mt-2 text-[13.5px] text-muted">{labelStatus(ticket.status)} · {category(ticket.categoryCode).nameEn}</p>
      <p className="token mx-auto mt-3 max-w-[30ch] break-all text-[11px] leading-4 text-muted/70">id {ticket.id.slice(0, 18)}</p>
    </section>
  )
}

export default function Receipt() {
  const { id } = useParams()
  const { t } = useT()
  const nav = useNavigate()
  const [ticket, setTicket] = useState<Ticket | null>(null)

  useEffect(() => { if (id) api.getTicket(id).then(setTicket) }, [id])

  return (
    <div className="mx-auto min-h-dvh max-w-lg">
      <NavBar title={t('receipt.title')} onBack={() => nav('/')} />
      {ticket && <TokenHero ticket={ticket} />}
      {ticket && (
        <div className="px-5">
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}>
            <p className="mt-5 text-[14px] leading-6 text-muted">
              Keep this token. Facilities and the worker see the same number. The official token exists only after this confirmation — a saved draft does not.
            </p>
            <div className="mt-7 space-y-3">
              <Button onClick={() => nav(`/t/${ticket.id}`)}>{t('receipt.track')}</Button>
              <Button variant="outline" onClick={() => window.print()}><Printer size={15} /> Print receipt</Button>
            </div>
          </motion.div>
        </div>
      )}
    </div>
  )
}

export function SuccessMark() {
  return <span className="flex h-14 w-14 items-center justify-center rounded-full bg-inverse text-inverse-fg"><Check size={26} strokeWidth={2.2} /></span>
}

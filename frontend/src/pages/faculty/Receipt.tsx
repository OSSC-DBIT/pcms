import { useParams, useNavigate } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { Check, Printer } from 'lucide-react'
import { api, category, labelStatus, localName } from '../../lib/api'
import { useT } from '../../lib/i18n'
import { Button, Fade, NavBar, Skeleton } from '../../components/ui'
import type { Ticket } from '../../lib/types'

export function TokenHero({ ticket }: { ticket: Ticket }) {
  const { lang } = useT()
  const cat = category(ticket.categoryCode)
  return (
    <motion.section aria-label="Ticket token"
      initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} transition={{ type: 'spring', stiffness: 300, damping: 26 }}
      className="mx-4 mt-4 rounded-[18px] border border-dashed border-fg/40 bg-surface px-5 py-7 text-center shadow-[0_1px_2px_rgba(0,0,0,0.05)]">
      <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">Token</p>
      <p className="token mt-2 text-[30px] font-bold tracking-[-0.035em]">{ticket.token}</p>
      <p className="mt-2 text-[13.5px] text-muted">{labelStatus(ticket.status)} · {localName(cat, lang)}</p>
    </motion.section>
  )
}

export default function Receipt() {
  const { id } = useParams()
  const { t } = useT()
  const nav = useNavigate()
  const [ticket, setTicket] = useState<Ticket | null>(null)

  useEffect(() => { if (id) api.getTicket(id).then(setTicket) }, [id])

  return (
    <Fade className="mx-auto min-h-dvh max-w-lg pb-10">
      <NavBar title={t('receipt.title')} onBack={() => nav('/')} />
      {ticket ? (
        <>
          <span className="mx-auto mt-6 flex h-14 w-14 items-center justify-center rounded-full bg-inverse text-inverse-fg shadow-[0_6px_20px_rgba(0,0,0,0.2)]">
            <Check size={26} strokeWidth={2.4} />
          </span>
          <TokenHero ticket={ticket} />
          <div className="px-4">
            <p className="pretty mx-auto mt-6 max-w-[40ch] text-center text-[13.5px] leading-5 text-muted">{t('receipt.body')}</p>
            <div className="mt-8 space-y-3">
              <Button onClick={() => nav(`/t/${ticket.id}`)}>{t('receipt.track')}</Button>
              <Button variant="secondary" onClick={() => window.print()}><Printer size={15} /> {t('receipt.print')}</Button>
            </div>
          </div>
        </>
      ) : (
        <div className="space-y-3 px-4 pt-6"><Skeleton className="h-36" /><Skeleton className="h-12" /></div>
      )}
    </Fade>
  )
}

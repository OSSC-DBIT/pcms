import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus } from 'lucide-react'
import { api } from '../../lib/api'
import { useAuth } from '../../App'
import { useT } from '../../lib/i18n'
import { useOnline } from '../../lib/hooks'
import { Button, Fade, Skeleton } from '../../components/ui'
import TicketRow from '../../components/TicketRow'
import type { Ticket } from '../../lib/types'

export default function Home() {
  const { user } = useAuth()
  const { t } = useT()
  const nav = useNavigate()
  const online = useOnline()
  const [tickets, setTickets] = useState<Ticket[] | null>(null)

  useEffect(() => {
    if (!user) return
    let live = true
    api.listTickets('mine', user).then((ts) => live && setTickets(ts)).catch(() => live && setTickets([]))
    return () => { live = false }
  }, [user])

  const open = tickets?.filter((x) => !['Closed', 'Cancelled', 'Rejected', 'Duplicate'].includes(x.status)) ?? []
  const awaiting = tickets?.filter((x) => x.status === 'Resolved') ?? []
  const recent = tickets?.slice(0, 3) ?? []

  return (
    <Fade>
      <div className="px-5 pb-4 pt-8">
        <h1 className="text-[28px] font-semibold tracking-[-0.025em]">{t('home.greeting')}</h1>
        <p className="mt-1.5 max-w-[38ch] text-[14.5px] leading-5 text-muted">{t('home.subtitle')}</p>
        {!online && (
          <p role="status" className="mt-4 rounded-md border border-fg/25 px-4 py-3 text-[13.5px] leading-5">
            {t('error.offline')}
          </p>
        )}
        <Button className="mt-6" onClick={() => nav('/raise/type')}>
          <Plus size={17} strokeWidth={2.2} /> {t('empty.raise')}
        </Button>
      </div>

      {tickets === null ? (
        <div className="space-y-4 px-5 pt-4">
          <Skeleton className="h-5 w-28" />
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
        </div>
      ) : (
        <>
          {awaiting.length > 0 && (
            <section aria-labelledby="awaiting">
              <p id="awaiting" className="hairline-b px-5 pb-2 pt-5 text-[13px] font-medium text-muted">{t('home.awaiting')}</p>
              {awaiting.map((x) => <TicketRow key={x.id} ticket={x} />)}
            </section>
          )}
          <section aria-labelledby="open">
            <div className="hairline-b flex items-baseline justify-between px-5 pb-2 pt-5">
              <p id="open" className="text-[13px] font-medium text-muted">{t('home.open')}{open.length > 0 && ` · ${open.length}`}</p>
              {open.length > 3 && <button onClick={() => nav('/track')} className="text-[13px] text-fg underline underline-offset-4">{t('home.seeAll')}</button>}
            </div>
            {open.length === 0
              ? <p className="px-5 py-6 text-[14px] text-muted">{t('empty.tickets')}</p>
              : open.slice(0, 4).map((x) => <TicketRow key={x.id} ticket={x} />)}
          </section>
          {recent.length > 0 && (
            <section aria-labelledby="recent">
              <p id="recent" className="hairline-b px-5 pb-2 pt-5 text-[13px] font-medium text-muted">{t('home.recent')}</p>
              {recent.map((x) => <TicketRow key={x.id} ticket={x} />)}
            </section>
          )}
        </>
      )}
    </Fade>
  )
}

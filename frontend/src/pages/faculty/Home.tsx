import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertTriangle, Inbox, WifiOff } from 'lucide-react'
import { api } from '../../lib/api'
import { useAuth } from '../../App'
import { useT } from '../../lib/i18n'
import { useOnline } from '../../lib/hooks'
import { Banner, Card, EmptyState, Fade, LargeHeader, SectionLabel, Skeleton } from '../../components/ui'
import TicketRow from '../../components/TicketRow'
import type { Ticket } from '../../lib/types'

export default function Home() {
  const { user } = useAuth()
  const { t } = useT()
  const nav = useNavigate()
  const online = useOnline()
  const [tickets, setTickets] = useState<Ticket[] | null>(null)
  const [draft, setDraft] = useState<{ title: string } | null>(null)

  useEffect(() => {
    if (!user) return
    let live = true
    api.listTickets('mine', user).then((ts) => live && setTickets(ts)).catch(() => live && setTickets([]))
    try {
      const d = JSON.parse(localStorage.getItem('pcms.drafts') ?? '[]')
      if (d[0]?.title) setDraft({ title: d[0].title })
    } catch { /* no draft */ }
    return () => { live = false }
  }, [user])

  const open = tickets?.filter((x) => !['Closed', 'Cancelled', 'Rejected', 'Duplicate'].includes(x.status)) ?? []
  const awaiting = tickets?.filter((x) => x.status === 'Resolved') ?? []

  return (
    <Fade className="mx-auto min-h-dvh max-w-lg pb-32">
      <LargeHeader title={t('home.greeting')} subtitle={t('home.subtitle')} />
      <div className="px-4 pt-4">
        {!online && <Banner><span className="mr-1.5 inline-flex translate-y-[2px]"><WifiOff size={13} /></span>{t('error.offline')}</Banner>}
        {draft && (
          <button onClick={() => nav('/report')} className="mt-3 w-full">
            <Banner>
              <span className="mr-1.5 inline-flex translate-y-[2px]"><AlertTriangle size={13} /></span>
              {t('draft.label')}: <span className="font-semibold">{draft.title}</span> — {t('draft.restore')}
            </Banner>
          </button>
        )}
      </div>

      {tickets === null ? (
        <div className="space-y-2.5 px-4 pt-6">
          <Skeleton className="h-[72px]" />
          <Skeleton className="h-[72px]" />
        </div>
      ) : (
        <>
          {awaiting.length > 0 && (
            <>
              <SectionLabel>{t('home.awaiting')}</SectionLabel>
              <Card className="inset-hr mx-4">{awaiting.map((x) => <TicketRow key={x.id} ticket={x} />)}</Card>
            </>
          )}
          <SectionLabel>{t('home.open')}{open.length > 0 ? ` · ${open.length}` : ''}</SectionLabel>
          {open.length === 0
            ? <EmptyState icon={<Inbox size={26} />} title={t('empty.tickets')} body={t('empty.ticketsBody')} />
            : <Card className="inset-hr mx-4">{open.map((x) => <TicketRow key={x.id} ticket={x} />)}</Card>}
        </>
      )}
    </Fade>
  )
}

import { useEffect, useState } from 'react'
import { Inbox } from 'lucide-react'
import { api } from '../../lib/api'
import { useAuth } from '../../App'
import { useT } from '../../lib/i18n'
import { Card, EmptyState, Fade, LargeHeader, Skeleton } from '../../components/ui'
import TicketRow from '../../components/TicketRow'
import type { Ticket } from '../../lib/types'

export default function Track() {
  const { user } = useAuth()
  const { t } = useT()
  const [tickets, setTickets] = useState<Ticket[] | null>(null)

  useEffect(() => {
    if (!user) return
    let live = true
    api.listTickets('mine', user)
      .then((ts) => live && setTickets(ts.filter((x) => !['Closed', 'Cancelled', 'Rejected', 'Duplicate'].includes(x.status))))
      .catch(() => live && setTickets([]))
    return () => { live = false }
  }, [user])

  return (
    <Fade className="mx-auto min-h-dvh max-w-lg pb-32">
      <LargeHeader title={t('nav.track')} />
      {tickets === null ? (
        <div className="space-y-2.5 px-4 pt-4">{[...Array(3)].map((_, i) => <Skeleton key={i} className="h-[72px]" />)}</div>
      ) : tickets.length === 0 ? (
        <EmptyState icon={<Inbox size={26} />} title={t('empty.tickets')} body={t('empty.ticketsBody')} />
      ) : (
        <Card className="inset-hr mx-4">{tickets.map((x) => <TicketRow key={x.id} ticket={x} />)}</Card>
      )}
    </Fade>
  )
}

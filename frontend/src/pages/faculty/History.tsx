import { useEffect, useState } from 'react'
import { Clock } from 'lucide-react'
import { api } from '../../lib/api'
import { useAuth } from '../../App'
import { useT } from '../../lib/i18n'
import { Card, EmptyState, Fade, LargeHeader, Segmented, Skeleton } from '../../components/ui'
import TicketRow from '../../components/TicketRow'
import type { Ticket } from '../../lib/types'

export default function History() {
  const { user } = useAuth()
  const { t } = useT()
  const [filter, setFilter] = useState<'all' | 'closed' | 'open'>('all')
  const [tickets, setTickets] = useState<Ticket[] | null>(null)

  useEffect(() => {
    if (!user) return
    let live = true
    api.listTickets('mine', user).then((ts) => live && setTickets(ts))
    return () => { live = false }
  }, [user])

  const shown = (tickets ?? []).filter((x) =>
    filter === 'all' ? true : filter === 'closed' ? ['Closed', 'Cancelled', 'Rejected', 'Duplicate'].includes(x.status) : !['Closed', 'Cancelled', 'Rejected', 'Duplicate'].includes(x.status))

  return (
    <Fade className="mx-auto min-h-dvh max-w-lg pb-32">
      <LargeHeader title={t('nav.history')} />
      <div className="px-4 pb-3 pt-4">
        <Segmented label="history" value={filter} onChange={setFilter} options={[
          { value: 'all', label: 'All' },
          { value: 'open', label: 'Open' },
          { value: 'closed', label: 'Closed' },
        ]} />
      </div>
      {tickets === null ? (
        <div className="space-y-2.5 px-4">{[...Array(3)].map((_, i) => <Skeleton key={i} className="h-[72px]" />)}</div>
      ) : shown.length === 0 ? (
        <EmptyState icon={<Clock size={26} />} title={t('empty.history')} />
      ) : (
        <Card className="inset-hr mx-4">{shown.map((x) => <TicketRow key={x.id} ticket={x} />)}</Card>
      )}
    </Fade>
  )
}

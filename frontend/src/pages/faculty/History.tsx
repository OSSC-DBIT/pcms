import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import { useAuth } from '../../App'
import { useT } from '../../lib/i18n'
import { EmptyState, Fade, PageTitle, Segmented, Skeleton } from '../../components/ui'
import TicketRow from '../../components/TicketRow'
import type { Ticket } from '../../lib/types'

export default function History() {
  const { user } = useAuth()
  const { t } = useT()
  const [filter, setFilter] = useState<'all' | 'closed' | 'reopened'>('all')
  const [tickets, setTickets] = useState<Ticket[] | null>(null)

  useEffect(() => {
    if (!user) return
    let live = true
    api.listTickets('mine', user).then((ts) => live && setTickets(ts))
    return () => { live = false }
  }, [user])

  const shown = (tickets ?? []).filter((x) =>
    filter === 'all' ? true : filter === 'closed' ? ['Closed', 'Cancelled', 'Rejected', 'Duplicate'].includes(x.status) : ['Submitted', 'Triaged'].includes(x.status))

  return (
    <Fade>
      <PageTitle title={t('nav.history')} />
      <div className="px-5 pb-2">
        <Segmented label="history-filter" value={filter} onChange={setFilter} options={[
          { value: 'all', label: 'All' },
          { value: 'closed', label: 'Closed' },
          { value: 'reopened', label: 'Open' },
        ]} />
      </div>
      {tickets === null ? (
        <div className="space-y-4 px-5 pt-3">{[...Array(3)].map((_, i) => <Skeleton key={i} className="h-20" />)}</div>
      ) : shown.length === 0 ? (
        <EmptyState title={t('error.notFound')} />
      ) : (
        shown.map((x) => <TicketRow key={x.id} ticket={x} />)
      )}
    </Fade>
  )
}

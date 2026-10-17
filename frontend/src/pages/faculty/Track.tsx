import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import { useAuth } from '../../App'
import { useT } from '../../lib/i18n'
import { EmptyState, Fade, PageTitle, Skeleton } from '../../components/ui'
import TicketRow from '../../components/TicketRow'
import type { Ticket } from '../../lib/types'
import { useNavigate } from 'react-router-dom'
import { Plus } from 'lucide-react'
import { Button } from '../../components/ui'

export default function Track() {
  const { user } = useAuth()
  const { t } = useT()
  const nav = useNavigate()
  const [tickets, setTickets] = useState<Ticket[] | null>(null)

  useEffect(() => {
    if (!user) return
    let live = true
    api.listTickets('mine', user).then((ts) => live && setTickets(ts.filter((x) => !['Closed', 'Cancelled', 'Rejected', 'Duplicate'].includes(x.status))))
      .catch(() => live && setTickets([]))
    return () => { live = false }
  }, [user])

  return (
    <Fade>
      <PageTitle title={t('nav.track')} />
      {tickets === null ? (
        <div className="space-y-4 px-5">{[...Array(4)].map((_, i) => <Skeleton key={i} className="h-20" />)}</div>
      ) : tickets.length === 0 ? (
        <EmptyState title={t('empty.tickets')} action={<Button onClick={() => nav('/raise/type')}><Plus size={16} /> {t('empty.raise')}</Button>} />
      ) : (
        tickets.map((x) => <TicketRow key={x.id} ticket={x} />)
      )}
    </Fade>
  )
}

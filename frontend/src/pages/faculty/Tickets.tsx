import { useState } from 'react'
import { TicketList, TicketRow } from '../../components/ticket'
import { Alert, EmptyState, PageHeader, Skeleton, Stack, Tabs } from '../../components/ui'
import { useT } from '../../lib/i18n'
import { useTickets } from '../../lib/useTickets'
import { TERMINAL } from '../../lib/types'

export default function Tickets() {
  const { t } = useT()
  const [tab, setTab] = useState<'open' | 'closed'>('open')
  const { tickets, error } = useTickets('mine')
  const shown = (tickets ?? []).filter((x) => (tab === 'open') !== TERMINAL.includes(x.status))
  return (
    <Stack>
      <PageHeader title={t('nav.tickets')} />
      <Tabs label="Ticket filter" value={tab} onChange={setTab} tabs={[{ value: 'open', label: t('tickets.open') }, { value: 'closed', label: t('tickets.closed') }]} />
      {error && <Alert tone="bad">{error}</Alert>}
      {tickets === null ? <Skeleton className="h-40" />
        : shown.length === 0 ? <EmptyState title={t('tickets.empty')} />
          : <TicketList>{shown.map((x) => <TicketRow key={x.id} ticket={x} to={`/t/${x.id}`} />)}</TicketList>}
    </Stack>
  )
}

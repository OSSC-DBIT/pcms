import { useState } from 'react'
import { Pager } from '../../components/Pager'
import { TicketList, TicketRow } from '../../components/ticket'
import { Alert, EmptyState, PageHeader, Skeleton, Stack, Tabs } from '../../components/ui'
import { useT } from '../../lib/i18n'
import { useTickets } from '../../lib/useTickets'

export default function Tickets() {
  const { t } = useT()
  const [tab, setTab] = useState<'open' | 'closed'>('open')
  // The server owns the open/closed split, so the page count matches what is on screen.
  const { tickets, error, total, page, pageSize, pageCount, setPage, setPageSize } = useTickets('mine', {
    open: tab === 'open',
  })
  const shown = tickets ?? []
  return (
    <Stack>
      <PageHeader title={t('nav.tickets')} />
      <Tabs label={t('tickets.filter')} value={tab} onChange={setTab}
        tabs={[{ value: 'open', label: t('tickets.open') }, { value: 'closed', label: t('tickets.closed') }]} />
      {error && <Alert tone="bad">{error}</Alert>}
      {tickets === null ? <Skeleton className="h-40" />
        : shown.length === 0 ? <EmptyState title={t('tickets.empty')} />
          : (
            <>
              <TicketList>{shown.map((x) => <TicketRow key={x.id} ticket={x} to={`/t/${x.id}`} />)}</TicketList>
              <Pager page={page} pageCount={pageCount} total={total} pageSize={pageSize} onPage={setPage} onPageSize={setPageSize} />
            </>
          )}
    </Stack>
  )
}

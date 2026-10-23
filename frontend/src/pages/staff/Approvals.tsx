import { Pager } from '../../components/Pager'
import { TicketList, TicketRow } from '../../components/ticket'
import { Alert, Badge, EmptyState, PageHeader, Skeleton, Stack } from '../../components/ui'
import { formatPaise } from '../../lib/api'
import { useTickets } from '../../lib/useTickets'

export default function Approvals() {
  const { tickets, error, total, page, pageSize, pageCount, setPage, setPageSize } = useTickets('queue', {
    status: ['AwaitingApproval'],
  })
  const shown = tickets ?? []
  return (
    <Stack>
      <PageHeader title="Approvals" subtitle="Cost proposals waiting for a decision. You cannot approve a cost you requested." />
      {error && <Alert tone="bad">{error}</Alert>}
      {tickets === null ? <Skeleton className="h-40" /> : shown.length === 0 ? <EmptyState title="Nothing waiting" /> : (
        <>
          <TicketList>
            {shown.map((x) => <TicketRow key={x.id} ticket={x} to={`/staff/t/${x.id}`}
              extra={x.proposal && <Badge tone="warn">{formatPaise(x.proposal.totalPaise)} · v{x.proposal.version}</Badge>} />)}
          </TicketList>
          <Pager page={page} pageCount={pageCount} total={total} pageSize={pageSize} onPage={setPage} onPageSize={setPageSize} />
        </>
      )}
    </Stack>
  )
}

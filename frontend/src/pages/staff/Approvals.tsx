import { TicketList, TicketRow } from '../../components/ticket'
import { Alert, Badge, EmptyState, PageHeader, Skeleton, Stack } from '../../components/ui'
import { formatPaise } from '../../lib/api'
import { useTickets } from '../../lib/useTickets'

export default function Approvals() {
  const { tickets, error } = useTickets('queue', { status: ['AwaitingApproval'] })
  return (
    <Stack>
      <PageHeader title="Approvals" subtitle="Cost proposals waiting for a decision. You cannot approve a cost you requested." />
      {error && <Alert tone="bad">{error}</Alert>}
      {tickets === null ? <Skeleton className="h-40" /> : tickets.length === 0 ? <EmptyState title="Nothing waiting" /> : (
        <TicketList>
          {tickets.map((x) => <TicketRow key={x.id} ticket={x} to={`/staff/t/${x.id}`}
            extra={x.proposal && <Badge tone="warn">{formatPaise(x.proposal.totalPaise)} · v{x.proposal.version}</Badge>} />)}
        </TicketList>
      )}
    </Stack>
  )
}

import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Wallet } from 'lucide-react'
import { api, formatPaise } from '../../lib/api'
import { Card, EmptyState, Fade, NavBar, Row, Skeleton } from '../../components/ui'
import type { Ticket } from '../../lib/types'

export default function Approvals() {
  const nav = useNavigate()
  const [tickets, setTickets] = useState<Ticket[] | null>(null)

  useEffect(() => {
    let live = true
    api.listTickets('all', { id: 'x' } as never).then((ts) =>
      live && setTickets(ts.filter((x) => x.status === 'AwaitingApproval')))
    return () => { live = false }
  }, [])

  return (
    <Fade className="mx-auto min-h-dvh max-w-lg pb-12">
      <NavBar title="Escalated costs" />
      <p className="pretty px-4 pb-3 pt-4 text-[12.5px] leading-5 text-muted">
        Every decision binds to a proposal version. Approve sets a ceiling; changed scope or higher cost returns for a new approval. Requesters never approve their own requests.
      </p>
      {tickets === null ? (
        <div className="space-y-2.5 px-4">{[...Array(2)].map((_, i) => <Skeleton key={i} className="h-[68px]" />)}</div>
      ) : tickets.length === 0 ? (
        <EmptyState icon={<Wallet size={26} />} title="Nothing awaiting decision" body="Cost proposals land here when a manager escalates expenditure." />
      ) : (
        <Card className="inset-hr mx-4">
          {tickets.map((tk) => (
            <Row key={tk.id} title={tk.title}
              detail={<span className="token">{tk.token} · v{tk.proposal?.version} · {tk.proposal?.lines.length} line items · requested {tk.proposal?.requestedDate}</span>}
              right={<span className="token text-[15px] font-bold">{formatPaise(tk.proposal?.totalPaise ?? 0)}</span>}
              onClick={() => nav(`/admin/t/${tk.id}`)} />
          ))}
        </Card>
      )}
    </Fade>
  )
}

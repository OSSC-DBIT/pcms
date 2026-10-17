import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, formatPaise } from '../../lib/api'
import { Fade, NavBar, Skeleton } from '../../components/ui'
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
    <Fade className="mx-auto min-h-dvh max-w-lg">
      <NavBar title="Escalated costs" />
      <p className="px-5 pb-3 pt-4 text-[13px] leading-5 text-muted">
        Every decision binds to a proposal version. Approve sets a ceiling; changed scope or higher cost returns for a new approval. Requesters never approve their own requests.
      </p>
      {tickets === null ? (
        <div className="space-y-4 px-5">{[...Array(2)].map((_, i) => <Skeleton key={i} className="h-24" />)}</div>
      ) : tickets.length === 0 ? (
        <p className="px-5 py-10 text-center text-[14px] text-muted">Nothing awaiting decision.</p>
      ) : tickets.map((tk) => (
        <button key={tk.id} onClick={() => nav(`/toal/t/${tk.id}`)} className="hairline-b block w-full px-5 py-4 text-left active:bg-subtle">
          <div className="flex items-baseline justify-between gap-3">
            <p className="token text-[13px] text-muted">{tk.token}</p>
            <p className="token text-[15px] font-semibold">{formatPaise(tk.proposal?.totalPaise ?? 0)}</p>
          </div>
          <p className="mt-1 truncate text-[14.5px] font-medium">{tk.title}</p>
          <p className="mt-0.5 text-[12.5px] text-muted">v{tk.proposal?.version} · {tk.proposal?.lines.length} line items · requested {tk.proposal?.requestedDate}</p>
        </button>
      ))}
    </Fade>
  )
}

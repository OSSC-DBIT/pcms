import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronRight, Users, Wallet, Inbox } from 'lucide-react'
import { api, category, localName } from '../../lib/api'
import { useAuth } from '../../App'
import { useT } from '../../lib/i18n'
import { Card, CheckChip, EmptyState, Fade, FlagMark, LargeHeader, Row, SectionLabel, Segmented, Skeleton, StatusChip } from '../../components/ui'
import { locationLine, relTime } from '../../components/TicketRow'
import type { Priority, Ticket } from '../../lib/types'

type Queue = 'action' | 'waiting' | 'all'

export default function AdminHome() {
  const { user } = useAuth()
  const { lang } = useT()
  const nav = useNavigate()
  const [tickets, setTickets] = useState<Ticket[] | null>(null)
  const [queue, setQueue] = useState<Queue>('action')
  const [priority, setPriority] = useState<Priority | 'any'>('any')

  const canQueue = user?.capabilities.includes('queue.view')
  const canApprove = user?.capabilities.includes('cost.approve')
  const canAdmin = user?.capabilities.includes('admin.catalogs')
  const canWorkers = user?.capabilities.includes('worker.directory')

  useEffect(() => {
    if (!user) return
    let live = true
    api.listTickets('all', user).then((ts) => live && setTickets(ts))
    return () => { live = false }
  }, [user])

  const counts = useMemo(() => {
    const ts = tickets ?? []
    return {
      untriaged: ts.filter((x) => x.status === 'Submitted').length,
      unaccepted: ts.filter((x) => x.status === 'Assigned' && !x.assignments.some((a) => a.accepted)).length,
      approvals: ts.filter((x) => x.status === 'AwaitingApproval').length,
      overdue: ts.filter((x) => x.nextUpdateDue && new Date(x.nextUpdateDue) < new Date() && !['Closed', 'Resolved'].includes(x.status)).length,
    }
  }, [tickets])

  const shown = useMemo(() => {
    let ts = tickets ?? []
    if (queue === 'action') ts = ts.filter((x) => ['Submitted', 'AwaitingApproval', 'Resolved'].includes(x.status) || (x.status === 'Assigned' && !x.assignments.some((a) => a.accepted)))
    if (queue === 'waiting') ts = ts.filter((x) => ['OnHold', 'Assigned', 'InProgress', 'Triaged'].includes(x.status))
    if (priority !== 'any') ts = ts.filter((x) => x.priority === priority)
    return ts
  }, [tickets, queue, priority])

  if (!canQueue && !canApprove) return <Fade><p className="px-4 pt-10 text-[14px] text-muted">This role has no queue access.</p></Fade>

  return (
    <Fade className="mx-auto min-h-dvh max-w-lg pb-12">
      <LargeHeader title="Admin portal" subtitle={user?.name} />
      {tickets && (
        <div className="mx-4 mt-5 grid grid-cols-4 overflow-hidden rounded-[14px] bg-surface shadow-[0_1px_2px_rgba(0,0,0,0.05)]">
          {([['New', counts.untriaged], ['Unacc.', counts.unaccepted], ['Overdue', counts.overdue], ['Costs', counts.approvals]] as const).map(([label, n], i) => (
            <div key={label} className={`px-1 py-3 text-center ${i > 0 ? 'border-l border-line' : ''}`}>
              <p className="token text-[18px] font-bold">{n}</p>
              <p className="mt-0.5 text-[10.5px] font-medium text-muted">{label}</p>
            </div>
          ))}
        </div>
      )}

      <div className="space-y-3 px-4 pb-1 pt-5">
        {canQueue && (
          <Segmented label="queue" value={queue} onChange={setQueue} options={[
            { value: 'action', label: 'Needs action' }, { value: 'waiting', label: 'In flight' }, { value: 'all', label: 'All' },
          ]} />
        )}
        <div className="flex items-center gap-2 overflow-x-auto pb-1">
          {(['any', 'P1', 'P2', 'P3', 'P4'] as const).map((p) => (
            <CheckChip key={p} selected={priority === p} onClick={() => setPriority(p)}>{p === 'any' ? 'All priorities' : p}</CheckChip>
          ))}
        </div>
      </div>

      {canApprove && counts.approvals > 0 && (
        <Card className="mx-4 mt-3">
          <Row title={`${counts.approvals} cost proposal${counts.approvals > 1 ? 's' : ''} awaiting decision`} right={<Wallet size={17} className="text-muted" />} onClick={() => nav('/admin/approvals')} />
        </Card>
      )}
      <div className="mx-4 mt-3 space-y-0.5">
        {canWorkers && (
          <Card>
            <Row title="Worker directory" right={<Users size={17} className="text-muted" />} onClick={() => nav('/admin/workers')} />
          </Card>
        )}
        {canAdmin && (
          <Card className="mt-2">
            <Row title="Catalogs, locations, roles, templates" right={<ChevronRight size={17} className="text-muted" />} onClick={() => nav('/admin/settings')} />
          </Card>
        )}
      </div>

      {tickets === null ? (
        <div className="space-y-2.5 px-4 pt-6">{[...Array(3)].map((_, i) => <Skeleton key={i} className="h-[72px]" />)}</div>
      ) : shown.length === 0 ? (
        <EmptyState icon={<Inbox size={26} />} title="Nothing in this queue" body="New reports arrive here as they are submitted." />
      ) : (
        <>
          <SectionLabel>{queue === 'action' ? 'Needs action' : queue === 'waiting' ? 'In flight' : 'All tickets'}</SectionLabel>
          <Card className="inset-hr mx-4">
            {shown.map((ticket) => (
              <Row key={ticket.id}
                title={ticket.title}
                detail={
                  <span className="flex flex-wrap items-center gap-x-1.5">
                    <span className="token">{ticket.token}</span><span aria-hidden>·</span>
                    {localName(category(ticket.categoryCode), lang)}<span aria-hidden>·</span>
                    <span className="token">{ticket.priority}</span>
                    {ticket.flag && <FlagMark flag={ticket.flag} />}
                    <span aria-hidden>·</span>
                    {locationLine(ticket, lang)}<span aria-hidden>·</span>
                    {relTime(ticket.createdAt)}
                  </span>
                }
                right={<StatusChip status={ticket.status} />}
                onClick={() => nav(`/admin/t/${ticket.id}`)} />
            ))}
          </Card>
        </>
      )}

      <p className="pretty mx-auto mt-8 max-w-[46ch] px-6 text-center text-[11.5px] leading-4 text-muted/80">
        Targets — P1: 15 min triage · P2: 1 working hour · P3: 1 working day. Gross age always visible; holds do not hide it.
      </p>
    </Fade>
  )
}

import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronRight, Users, Wallet, SlidersHorizontal } from 'lucide-react'
import { api, category, labelStatus } from '../../lib/api'
import { useAuth } from '../../App'
import { useT } from '../../lib/i18n'
import { Button, Fade, FlagMark, Segmented, Skeleton, StatusChip } from '../../components/ui'
import { locationLine, relTime } from '../../components/TicketRow'
import type { Priority, Ticket } from '../../lib/types'

type Queue = 'action' | 'waiting' | 'all'

export default function ToalHome() {
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
      holds: ts.filter((x) => x.status === 'OnHold').length,
      overdue: ts.filter((x) => x.nextUpdateDue && new Date(x.nextUpdateDue) < new Date() && !['Closed', 'Resolved'].includes(x.status)).length,
      resolved: ts.filter((x) => x.status === 'Resolved').length,
    }
  }, [tickets])

  const shown = useMemo(() => {
    let ts = tickets ?? []
    if (queue === 'action') ts = ts.filter((x) => ['Submitted', 'AwaitingApproval', 'Resolved'].includes(x.status) || (x.status === 'Assigned' && !x.assignments.some((a) => a.accepted)))
    if (queue === 'waiting') ts = ts.filter((x) => ['OnHold', 'Assigned', 'InProgress', 'Triaged'].includes(x.status))
    if (priority !== 'any') ts = ts.filter((x) => x.priority === priority)
    return ts
  }, [tickets, queue, priority])

  if (!canQueue && !canApprove) return <Fade><p className="px-5 pt-10 text-muted">This role has no queue access.</p></Fade>

  return (
    <Fade className="mx-auto min-h-dvh max-w-lg">
      <header className="safe-top sticky top-0 z-30 border-b border-line bg-bg/92 backdrop-blur-xl">
        <div className="px-5 pb-3 pt-6">
          <div className="flex items-baseline justify-between">
            <h1 className="token text-[22px] font-semibold tracking-[-0.03em]">toal</h1>
            <p className="text-[12.5px] text-muted">{user?.name} · {user?.role.replace('_', ' ')}</p>
          </div>
          {tickets && (
            <div className="mt-4 grid grid-cols-4 gap-px overflow-hidden rounded-md border border-line bg-line text-center">
              {[
                ['New', counts.untriaged], ['Unacc.', counts.unaccepted], ['Overdue', counts.overdue], ['Approvals', counts.approvals],
              ].map(([label, n]) => (
                <div key={String(label)} className="bg-bg px-1 py-2.5">
                  <p className="token text-[17px] font-semibold">{n as number}</p>
                  <p className="text-[10.5px] text-muted">{label as string}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      </header>

      <div className="space-y-3 px-5 pb-4 pt-4">
        {canQueue && (
          <Segmented label="queue" value={queue} onChange={setQueue} options={[
            { value: 'action', label: 'Needs action' }, { value: 'waiting', label: 'In flight' }, { value: 'all', label: 'All' },
          ]} />
        )}
        <div className="flex items-center gap-2">
          <SlidersHorizontal size={13} className="text-muted" />
          {(['any', 'P1', 'P2', 'P3', 'P4'] as const).map((p) => (
            <button key={p} onClick={() => setPriority(p)}
              className={`token rounded-full border px-2.5 py-1 text-[12px] ${priority === p ? 'border-fg bg-inverse text-inverse-fg' : 'border-line text-muted'}`}>
              {p === 'any' ? 'All' : p}
            </button>
          ))}
        </div>
      </div>

      {canApprove && counts.approvals > 0 && (
        <button onClick={() => nav('/toal/approvals')} className="mx-5 mb-3 flex w-[calc(100%-2.5rem)] items-center justify-between rounded-md border border-line px-4 py-3.5 text-left active:bg-subtle">
          <span className="flex items-center gap-2.5 text-[14px] font-medium"><Wallet size={15} className="text-muted" /> {counts.approvals} cost proposal{counts.approvals > 1 ? 's' : ''} awaiting decision</span>
          <ChevronRight size={15} className="text-muted" />
        </button>
      )}
      {canWorkers && (
        <button onClick={() => nav('/toal/workers')} className="mx-5 mb-3 flex w-[calc(100%-2.5rem)] items-center justify-between rounded-md border border-line px-4 py-3.5 text-left active:bg-subtle sm:w-auto sm:max-w-none">
          <span className="flex items-center gap-2.5 text-[14px] font-medium"><Users size={15} className="text-muted" /> Worker directory</span>
          <ChevronRight size={15} className="text-muted" />
        </button>
      )}
      {canAdmin && (
        <Button variant="outline" className="mx-5 mb-4" onClick={() => nav('/toal/admin')}>Users, categories, locations, audit</Button>
      )}

      {tickets === null ? (
        <div className="space-y-4 px-5">{[...Array(4)].map((_, i) => <Skeleton key={i} className="h-[74px]" />)}</div>
      ) : shown.length === 0 ? (
        <p className="px-5 py-10 text-center text-[14px] text-muted">Nothing in this queue.</p>
      ) : (
        shown.map((ticket) => (
          <button key={ticket.id} onClick={() => nav(`/toal/t/${ticket.id}`)} className="hairline-b block w-full px-5 py-3.5 text-left">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-[14.5px] font-medium">{ticket.title}</p>
                <p className="token mt-1 text-[12px] text-muted">
                  {ticket.token} · {lang === 'hi' ? category(ticket.categoryCode).nameHi : category(ticket.categoryCode).nameEn} · {ticket.priority}
                  {ticket.flag && <FlagMark flag={ticket.flag} />}
                </p>
                <p className="mt-0.5 truncate text-[12.5px] text-muted">{locationLine(ticket)} · {relTime(ticket.createdAt)}</p>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1.5">
                <StatusChip status={ticket.status} />
                {ticket.assignments.length > 0 && !ticket.assignments.some((a) => a.accepted) && ticket.status === 'Assigned' && (
                  <span className="text-[11px] text-fg underline underline-offset-2">awaiting accept</span>
                )}
              </div>
            </div>
          </button>
        ))
      )}

      <footer className="px-5 py-8 text-[11.5px] text-muted/70">
        Targets — P1: 15 min triage · P2: 1 working hr · P3: 1 working day. Gross age always visible; holds do not hide it. {labelStatus('Submitted')}…
      </footer>
      <div className="h-20" />
      <nav className="safe-bottom fixed inset-x-0 bottom-0 border-t border-line bg-bg/92 backdrop-blur-xl">
        <div className="mx-auto flex max-w-lg justify-around py-2">
          <Button variant="ghost" className="w-auto" onClick={() => nav('/')}>Faculty portal</Button>
          <Button variant="ghost" className="w-auto" onClick={() => nav('/settings')}>Settings</Button>
        </div>
      </nav>
    </Fade>
  )
}

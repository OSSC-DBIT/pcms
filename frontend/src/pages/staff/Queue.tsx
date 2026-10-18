import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle } from 'lucide-react'
import { useAuth } from '../../App'
import { TicketList, TicketRow } from '../../components/ticket'
import { Alert, Badge, Button, Card, EmptyState, PageHeader, Select, Skeleton, Stack, Tabs } from '../../components/ui'
import { api, type FailedNotification } from '../../lib/api'
import { buildings } from '../../lib/catalog'
import { useTickets } from '../../lib/useTickets'
import type { Priority, TicketSummary } from '../../lib/types'

type View = 'action' | 'working' | 'all'

const unaccepted = (x: TicketSummary) => x.status === 'Assigned' && !x.assignments.some((a) => a.accepted && !a.releasedAt)
const needsAction = (x: TicketSummary) => ['Submitted', 'AwaitingApproval', 'Resolved'].includes(x.status) || unaccepted(x)

export default function Queue() {
  const { can } = useAuth()
  const { tickets, error, reload } = useTickets('queue', { open: true })
  const [view, setView] = useState<View>('action')
  const [priority, setPriority] = useState<Priority | ''>('')
  const [place, setPlace] = useState('')

  const counts = useMemo(() => {
    const ts = tickets ?? []
    const now = Date.now()
    return {
      new: ts.filter((x) => x.status === 'Submitted').length,
      unaccepted: ts.filter(unaccepted).length,
      overdue: ts.filter((x) => x.nextUpdateDue && new Date(x.nextUpdateDue).getTime() < now && x.status !== 'Resolved').length,
      approvals: ts.filter((x) => x.status === 'AwaitingApproval').length,
    }
  }, [tickets])

  const shown = useMemo(() => (tickets ?? []).filter((x) =>
    (view === 'all' || (view === 'action' ? needsAction(x) : !needsAction(x)))
    && (!priority || x.priority === priority) && (!place || x.location.building === place)), [tickets, view, priority, place])

  return (
    <Stack>
      <PageHeader title="Queue" subtitle="Open tickets across campus" actions={<Button variant="secondary" size="sm" onClick={() => void reload()}>Refresh</Button>} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="New" value={counts.new} />
        <Stat label="Not accepted" value={counts.unaccepted} />
        <Stat label="Update overdue" value={counts.overdue} tone={counts.overdue ? 'bad' : undefined} />
        <Stat label="Waiting approval" value={counts.approvals} />
      </div>
      {can('queue.view') && <FailedMessages />}
      <div className="flex flex-wrap items-center gap-3">
        <Tabs label="Queue view" value={view} onChange={setView} tabs={[
          { value: 'action', label: 'Needs action' }, { value: 'working', label: 'In progress' }, { value: 'all', label: 'All open' }]} />
        <div className="w-32"><Select aria-label="Priority" value={priority} onChange={(e) => setPriority(e.target.value as Priority | '')}>
          <option value="">Any priority</option>{(['P1', 'P2', 'P3', 'P4'] as const).map((p) => <option key={p}>{p}</option>)}
        </Select></div>
        <div className="w-56"><Select aria-label="Building" value={place} onChange={(e) => setPlace(e.target.value)}>
          <option value="">All buildings</option>{buildings().map((b) => <option key={b.code} value={b.code}>{b.nameEn}</option>)}
        </Select></div>
      </div>
      {error && <Alert tone="bad">{error}</Alert>}
      {tickets === null ? <Skeleton className="h-60" /> : shown.length === 0 ? <EmptyState title="Nothing here" body="No tickets match this view." /> : (
        <TicketList>
          {shown.map((x) => <TicketRow key={x.id} ticket={x} to={`/staff/t/${x.id}`}
            extra={<><Badge>{x.priority}</Badge>{x.flag && <Badge>{x.flag}</Badge>}{unaccepted(x) && <Badge tone="warn">Not accepted</Badge>}</>} />)}
        </TicketList>
      )}
    </Stack>
  )
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'bad' }) {
  return (
    <div className="rounded-lg border border-line bg-surface px-4 py-3">
      <p className={`text-[24px] font-semibold ${tone === 'bad' ? 'text-bad' : ''}`}>{value}</p>
      <p className="text-[13px] text-muted">{label}</p>
    </div>
  )
}

function FailedMessages() {
  const { can } = useAuth()
  const [items, setItems] = useState<FailedNotification[]>([])
  useEffect(() => { api.listFailedNotifications().then(setItems).catch(() => setItems([])) }, [])
  if (!items.length) return null
  const act = async (id: number, op: 'retry' | 'dismiss') => { await api.actOnNotification(id, op); setItems((xs) => xs.filter((x) => x.id !== id)) }
  return (
    <Card title={<span className="inline-flex items-center gap-2 text-warn"><AlertTriangle size={17} /> {items.length} message(s) need you</span>}>
      <ul className="divide-y divide-line">
        {items.slice(0, 6).map((n) => (
          <li key={n.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-[14px]">
            <span className="min-w-0">
              {n.ticketId ? <Link to={`/staff/t/${n.ticketId}`} className="token font-semibold text-accent">{n.ticketToken}</Link> : '-'} · {n.channel} to {n.recipient}
              <span className="block text-[13px] text-muted">{n.lastError ?? 'Delivery failed'}</span>
            </span>
            {can('ticket.assign') && (
              <span className="flex gap-2">
                <Button size="sm" variant="secondary" onClick={() => act(n.id, 'retry')}>Retry</Button>
                <Button size="sm" variant="ghost" onClick={() => act(n.id, 'dismiss')}>Handled by call</Button>
              </span>
            )}
          </li>
        ))}
      </ul>
    </Card>
  )
}

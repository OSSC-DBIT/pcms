import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, Search, X } from 'lucide-react'
import { useAuth } from '../../App'
import { Pager } from '../../components/Pager'
import { TicketList, TicketRow } from '../../components/ticket'
import { Alert, Badge, Button, Card, EmptyState, Input, PageHeader, Select, Skeleton, Stack, Tabs } from '../../components/ui'
import { api, type FailedNotification } from '../../lib/api'
import { buildings, categories } from '../../lib/catalog'
import { useT, type TKey } from '../../lib/i18n'
import { useTickets, type UseTicketsOptions } from '../../lib/useTickets'
import type { Priority, TicketSort, TicketSummary, WorkFlag } from '../../lib/types'

type View = 'action' | 'working' | 'all'

const needsAction = (x: TicketSummary, canTriage: boolean) =>
  ['Submitted', 'AwaitingApproval', 'Resolved'].includes(x.status) ||
  (canTriage && x.status === 'InProgress' && x.proposal?.state === 'approved')

const SORTS: { value: TicketSort; key: TKey }[] = [
  { value: 'newest', key: 'sort.newest' },
  { value: 'oldest', key: 'sort.oldest' },
  { value: 'priority', key: 'sort.priority' },
  { value: 'updated', key: 'sort.updated' },
]

export default function Queue() {
  const { can } = useAuth()
  const { t } = useT()
  const [view, setView] = useState<View>('action')
  const [search, setSearch] = useState('')
  const [applied, setApplied] = useState('')
  const [priority, setPriority] = useState<Priority | ''>('')
  const [place, setPlace] = useState('')
  const [kind, setKind] = useState('')
  const [flag, setFlag] = useState<WorkFlag | ''>('')
  const [workerName, setWorkerName] = useState('')
  const [sort, setSort] = useState<TicketSort>('newest')
  const [counts, setCounts] = useState({ new: 0, assigned: 0, overdue: 0, approvals: 0 })

  // Every filter below is applied by the server, not in the browser.
  const filters: UseTicketsOptions = {
    open: true,
    search: applied || undefined,
    priority: priority || undefined,
    building: place || undefined,
    category: kind || undefined,
    flag: flag || undefined,
    worker: workerName.trim() || undefined,
    sort,
  }
  const { tickets, error, total, page, pageSize, pageCount, setPage, setPageSize, reload } = useTickets('queue', filters)
  const canTriage = can('ticket.triage')

  // The tiles must describe the whole open set, not the filtered page, so they come
  // from GET /reports rather than being counted from whatever rows are on screen.
  useEffect(() => {
    let live = true
    api.report({ days: 365, building: place || undefined, category: kind || undefined })
      .then((r) => { if (live) setCounts({ new: r.untriaged, assigned: r.openByStatus.Assigned ?? 0, overdue: r.overdueUpdates, approvals: r.pendingApprovals }) })
      .catch(() => { /* the tiles are a nicety; the list reports its own errors */ })
    return () => { live = false }
  }, [place, kind])

  const shown = useMemo(
    () => (tickets ?? []).filter((x) => view === 'all' || (view === 'action' ? needsAction(x, canTriage) : !needsAction(x, canTriage))),
    [tickets, view, canTriage],
  )

  const filtering = !!(applied || priority || place || kind || flag || workerName.trim())
  const clear = () => {
    setSearch(''); setApplied(''); setPriority(''); setPlace(''); setKind(''); setFlag(''); setWorkerName('')
  }

  return (
    <Stack>
      <PageHeader title={t('queue.title')} subtitle={t('queue.subtitle')} actions={<Button variant="secondary" size="sm" onClick={() => void reload()}>{t('queue.refresh')}</Button>} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label={t('queue.statNew')} value={counts.new} />
        <Stat label={t('queue.statAssigned')} value={counts.assigned} />
        <Stat label={t('queue.statOverdue')} value={counts.overdue} tone={counts.overdue ? 'bad' : undefined} />
        <Stat label={t('queue.statApprovals')} value={counts.approvals} />
      </div>
      {can('queue.view') && <FailedMessages />}

      <div className="flex flex-wrap items-center gap-3">
        <Tabs label={t('queue.view')} value={view} onChange={setView} tabs={[
          { value: 'action', label: t('queue.needsAction') }, { value: 'working', label: t('queue.inProgress') }, { value: 'all', label: t('queue.allOpen') }]} />
      </div>

      <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); setApplied(search.trim()) }}>
        <div className="w-full sm:w-64">
          <label htmlFor="queue-search" className="mb-1.5 block text-[13px] font-medium">{t('queue.search')}</label>
          <div className="relative">
            <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" aria-hidden />
            <Input id="queue-search" value={search} onChange={(e) => setSearch(e.target.value)}
              placeholder={t('queue.searchHint')} className="pl-9" autoComplete="off" />
          </div>
        </div>
        <div className="w-32">
          <label htmlFor="queue-priority" className="mb-1.5 block text-[13px] font-medium">{t('queue.priority')}</label>
          <Select id="queue-priority" value={priority} onChange={(e) => setPriority(e.target.value as Priority | '')}>
            <option value="">{t('queue.any')}</option>{(['P1', 'P2', 'P3', 'P4'] as const).map((p) => <option key={p}>{p}</option>)}
          </Select>
        </div>
        <div className="w-44">
          <label htmlFor="queue-building" className="mb-1.5 block text-[13px] font-medium">{t('queue.building')}</label>
          <Select id="queue-building" value={place} onChange={(e) => setPlace(e.target.value)}>
            <option value="">{t('queue.all')}</option>{buildings().map((b) => <option key={b.code} value={b.code}>{b.nameEn}</option>)}
          </Select>
        </div>
        <div className="w-44">
          <label htmlFor="queue-type" className="mb-1.5 block text-[13px] font-medium">{t('queue.type')}</label>
          <Select id="queue-type" value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">{t('queue.all')}</option>{categories().map((c) => <option key={c.code} value={c.code}>{c.nameEn}</option>)}
          </Select>
        </div>
        <div className="w-36">
          <label htmlFor="queue-flag" className="mb-1.5 block text-[13px] font-medium">{t('queue.flag')}</label>
          <Select id="queue-flag" value={flag} onChange={(e) => setFlag(e.target.value as WorkFlag | '')}>
            <option value="">{t('queue.any')}</option>
            <option value="I">{t('flag.I')}</option><option value="C">{t('flag.C')}</option><option value="P">{t('flag.P')}</option>
          </Select>
        </div>
        <div className="w-44">
          <label htmlFor="queue-worker" className="mb-1.5 block text-[13px] font-medium">{t('queue.worker')}</label>
          <Input id="queue-worker" value={workerName} onChange={(e) => setWorkerName(e.target.value)}
            placeholder={t('queue.anyone')} autoComplete="off" />
        </div>
        <div className="w-44">
          <label htmlFor="queue-sort" className="mb-1.5 block text-[13px] font-medium">{t('queue.sort')}</label>
          <Select id="queue-sort" value={sort} onChange={(e) => setSort(e.target.value as TicketSort)}>
            {SORTS.map((s) => <option key={s.value} value={s.value}>{t(s.key)}</option>)}
          </Select>
        </div>
        <Button type="submit">{t('queue.search')}</Button>
        {filtering && <Button type="button" variant="ghost" onClick={clear}><X size={16} /> {t('queue.clear')}</Button>}
      </form>

      {error && <Alert tone="bad">{error}</Alert>}
      {tickets === null ? <Skeleton className="h-60" /> : shown.length === 0 ? (
        <EmptyState title={t('queue.empty')} body={filtering ? t('queue.emptyFiltered') : t('queue.emptyView')}
          action={filtering ? <Button variant="secondary" onClick={clear}>{t('queue.clearFilters')}</Button> : undefined} />
      ) : (
        <>
          <TicketList>
            {shown.map((x) => <TicketRow key={x.id} ticket={x} to={`/staff/t/${x.id}`}
              extra={<><Badge>{x.priority}</Badge>{x.flag && <Badge>{x.flag}</Badge>}
                {x.status === 'InProgress' && x.proposal?.state === 'approved' && <Badge tone="ok">{t('queue.approved')}</Badge>}</>} />)}
          </TicketList>
          <Pager page={page} pageCount={pageCount} total={total} pageSize={pageSize} onPage={setPage} onPageSize={setPageSize} />
        </>
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
  const { t } = useT()
  const [items, setItems] = useState<FailedNotification[]>([])
  useEffect(() => { api.listFailedNotifications().then(setItems).catch(() => setItems([])) }, [])
  if (!items.length) return null
  const act = async (id: number, op: 'retry' | 'dismiss') => { await api.actOnNotification(id, op); setItems((xs) => xs.filter((x) => x.id !== id)) }
  return (
    <Card title={<span className="inline-flex items-center gap-2 text-warn"><AlertTriangle size={17} /> {items.length} {t('msgs.needYou')}</span>}>
      <ul className="divide-y divide-line">
        {items.slice(0, 6).map((n) => (
          <li key={n.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-[14px]">
            <span className="min-w-0">
              {n.ticketId ? <Link to={`/staff/t/${n.ticketId}`} className="token font-semibold text-accent">{n.ticketToken}</Link> : '-'} · {n.channel} to {n.recipient}
              <span className="block text-[13px] text-muted">{n.lastError ?? t('msgs.failed')}</span>
            </span>
            {can('ticket.assign') && (
              <span className="flex gap-2">
                <Button size="sm" variant="secondary" onClick={() => act(n.id, 'retry')}>{t('msgs.retry')}</Button>
                <Button size="sm" variant="ghost" onClick={() => act(n.id, 'dismiss')}>{t('msgs.handled')}</Button>
              </span>
            )}
          </li>
        ))}
      </ul>
    </Card>
  )
}

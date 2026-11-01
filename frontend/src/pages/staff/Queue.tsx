import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle } from 'lucide-react'
import { useAuth } from '../../App'
import { FilterChips, FilterField, FilterToggle, SearchBox, useUrlFilters, type Chip } from '../../components/Filters'
import { Pager } from '../../components/Pager'
import { TicketList, TicketRow } from '../../components/ticket'
import { Alert, Badge, Button, Card, Checkbox, EmptyState, Input, PageHeader, Select, Skeleton, Stack, Tabs } from '../../components/ui'
import { api, type FailedNotification } from '../../lib/api'
import { building, buildingDepartments, buildings, buildingName, categories, categoryName } from '../../lib/catalog'
import { useT, type TKey } from '../../lib/i18n'
import { useTickets, type UseTicketsOptions } from '../../lib/useTickets'
import { IMPACTS, TERMINAL, type Impact, type Role, type Status, type TicketSort, type WorkFlag } from '../../lib/types'
type View = 'action' | 'working' | 'all' | 'closed'
/** Every role can report a problem, so every role can be a filter. */
const REPORTER_ROLES: Role[] = ['faculty', 'facility_manager', 'management', 'principal', 'ossc']
const OPEN_STATUSES: Status[] = ['Submitted', 'Triaged', 'Assigned', 'InProgress', 'OnHold', 'AwaitingApproval', 'Resolved']
const FLAGS: { value: WorkFlag; key: TKey }[] = [{ value: 'I', key: 'ticket.immediate' }, { value: 'C', key: 'ticket.critical' }, { value: 'P', key: 'ticket.postpone' }]
const KEYS = ['view', 'q', 'status', 'severity', 'flag', 'type', 'building', 'department', 'reporter', 'role', 'worker', 'from', 'to', 'overdue', 'sort'] as const
type Key = typeof KEYS[number]

export default function Queue() {
  const { can } = useAuth()
  const { t, lang } = useT()
  const { values: f, set, clear } = useUrlFilters(KEYS)
  const view = (['action', 'working', 'all', 'closed'].includes(f.view) ? f.view : 'action') as View
  const sort = (f.sort || 'newest') as TicketSort
  const [panel, setPanel] = useState(false)
  const [counts, setCounts] = useState({ new: 0, assigned: 0, overdue: 0, approvals: 0 })
  const place = building(f.building)
  const departments = place ? buildingDepartments(place, lang) : []

  // Every filter, including the tabs, is applied by the server, so the total and pages match the list.
  const filters: UseTicketsOptions = {
    open: view === 'closed' ? false : f.status ? undefined : true,
    view: view === 'action' || view === 'working' ? view : undefined,
    status: f.status ? [f.status as Status] : undefined,
    search: f.q || undefined,
    severity: (f.severity as Impact) || undefined,
    flag: (f.flag as WorkFlag) || undefined,
    category: f.type || undefined,
    building: f.building || undefined,
    department: f.department || undefined,
    reporter: f.reporter || undefined,
    reporterRole: (f.role as Role) || undefined,
    worker: f.worker || undefined,
    from: f.from || undefined,
    to: f.to || undefined,
    overdue: f.overdue === '1' || undefined,
    sort,
  }
  const { tickets, error, total, page, pageSize, pageCount, setPage, setPageSize, reload } = useTickets('queue', filters)
  const sorts: { value: TicketSort; label: string }[] = [
    { value: 'newest', label: t('queue.newest') },
    { value: 'oldest', label: t('queue.oldest') },
    { value: 'severity', label: t('queue.severity') },
    { value: 'updated', label: t('queue.recentlyUpdated') },
  ]

  // The tiles describe the whole open set, so they come from GET /reports, not from this page.
  useEffect(() => {
    let live = true
    api.report({ days: 365, building: f.building || undefined, category: f.type || undefined })
      .then((r) => { if (live) setCounts({ new: r.untriaged, assigned: r.openByStatus.Assigned ?? 0, overdue: r.overdueUpdates, approvals: r.pendingApprovals }) })
      .catch(() => { /* the tiles are a nicety; the list reports its own errors */ })
    return () => { live = false }
  }, [f.building, f.type])

  const cat = f.type ? categories().find((c) => c.code === f.type) : undefined
  const chipDefs: [Key, ReactNode][] = [
    ['status', f.status && t(`status.${f.status}` as TKey)],
    ['severity', f.severity && t(`impact.${f.severity}` as TKey)],
    ['flag', f.flag && t(FLAGS.find((x) => x.value === f.flag)?.key ?? 'filter.flag')],
    ['type', cat && categoryName(cat, lang)],
    ['building', place && buildingName(place, lang)],
    ['department', f.department && (departments.find((d) => d.value === f.department)?.label ?? f.department)],
    ['reporter', f.reporter && `${t('queue.reporter')}: ${f.reporter}`],
    ['role', f.role && t(`role.${f.role}` as TKey)],
    ['worker', f.worker && `${t('filter.worker')}: ${f.worker}`],
    ['from', f.from && `${t('queue.from')} ${f.from}`],
    ['to', f.to && `${t('queue.to')} ${f.to}`],
    ['overdue', f.overdue && t('filter.overdue')],
  ]
  const chips: Chip[] = chipDefs.filter(([, label]) => !!label).map(([key, label]) => ({
    key, label, onRemove: () => set(key === 'building' ? { building: '', department: '' } : { [key]: '' }),
  }))
  const filtering = chips.length > 0 || !!f.q
  const clearAll = () => clear(['view', 'sort'])
  const showTiles = view !== 'closed'

  return (
    <Stack>
      <PageHeader title={t('queue.title')} subtitle={t('queue.subtitle')} actions={<Button variant="secondary" size="sm" onClick={() => void reload()}>{t('action.refresh')}</Button>} />
      {showTiles && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label={t('queue.new')} value={counts.new} onClick={() => set({ view: 'action', status: 'Submitted' })} />
          <Stat label={t('queue.assigned')} value={counts.assigned} onClick={() => set({ view: 'all', status: 'Assigned' })} />
          <Stat label={t('queue.overdue')} value={counts.overdue} tone={counts.overdue ? 'bad' : undefined} onClick={() => set({ view: 'all', overdue: '1' })} />
          <Stat label={t('queue.waitingApproval')} value={counts.approvals} onClick={() => set({ view: 'action', status: 'AwaitingApproval' })} />
        </div>
      )}
      {can('queue.view') && <FailedMessages />}

      <Tabs label={t('queue.view')} value={view} onChange={(v) => set({ view: v, status: '' })} tabs={[
        { value: 'action', label: t('queue.needsAction') }, { value: 'working', label: t('queue.inProgress') },
        { value: 'all', label: t('queue.allOpen') }, { value: 'closed', label: t('filter.closedView') }]} />

      <div className="flex flex-wrap items-center gap-2">
        <SearchBox id="queue-search" value={f.q} onSearch={(q) => set({ q })} placeholder={t('queue.searchPlaceholder')} />
        <FilterToggle open={panel} count={chips.length} onClick={() => setPanel((v) => !v)} />
        <label htmlFor="queue-sort" className="sr-only">{t('queue.sort')}</label>
        <Select id="queue-sort" className="w-auto flex-1 sm:flex-none" value={sort} onChange={(e) => set({ sort: e.target.value === 'newest' ? '' : e.target.value })}>
          {sorts.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </Select>
      </div>

      {panel && (
        <div className="grid gap-3 rounded-lg border border-line bg-surface p-4 sm:grid-cols-2 lg:grid-cols-4">
          <FilterField label={t('filter.status')} htmlFor="f-status">
            <Select id="f-status" value={f.status} onChange={(e) => set({ status: e.target.value, view: e.target.value ? (OPEN_STATUSES.includes(e.target.value as Status) ? 'all' : 'closed') : view })}>
              <option value="">{t('common.any')}</option>
              {(view === 'closed' ? TERMINAL : OPEN_STATUSES).map((s) => <option key={s} value={s}>{t(`status.${s}`)}</option>)}
            </Select>
          </FilterField>
          <FilterField label={t('queue.severity')} htmlFor="f-severity">
            <Select id="f-severity" value={f.severity} onChange={(e) => set({ severity: e.target.value })}>
              <option value="">{t('common.any')}</option>{IMPACTS.map((v) => <option key={v} value={v}>{t(`impact.${v}`)}</option>)}
            </Select>
          </FilterField>
          <FilterField label={t('filter.flag')} htmlFor="f-flag">
            <Select id="f-flag" value={f.flag} onChange={(e) => set({ flag: e.target.value })}>
              <option value="">{t('common.any')}</option>{FLAGS.map((x) => <option key={x.value} value={x.value}>{x.value}: {t(x.key)}</option>)}
            </Select>
          </FilterField>
          <FilterField label={t('queue.type')} htmlFor="f-type">
            <Select id="f-type" value={f.type} onChange={(e) => set({ type: e.target.value })}>
              <option value="">{t('common.all')}</option>{categories().map((c) => <option key={c.code} value={c.code}>{categoryName(c, lang)}</option>)}
            </Select>
          </FilterField>
          <FilterField label={t('queue.building')} htmlFor="f-building">
            <Select id="f-building" value={f.building} onChange={(e) => set({ building: e.target.value, department: '' })}>
              <option value="">{t('common.all')}</option>{buildings().map((b) => <option key={b.code} value={b.code}>{buildingName(b, lang)}</option>)}
            </Select>
          </FilterField>
          <FilterField label={t('filter.department')} htmlFor="f-department">
            <Select id="f-department" value={f.department} disabled={!departments.length} onChange={(e) => set({ department: e.target.value })}>
              <option value="">{t('common.all')}</option>{departments.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
            </Select>
          </FilterField>
          <FilterField label={t('queue.reporter')} htmlFor="f-reporter">
            <SearchBox id="f-reporter" value={f.reporter} onSearch={(reporter) => set({ reporter })} placeholder={t('queue.reporterPlaceholder')} />
          </FilterField>
          <FilterField label={t('queue.reporterRole')} htmlFor="f-role">
            <Select id="f-role" value={f.role} onChange={(e) => set({ role: e.target.value })}>
              <option value="">{t('common.any')}</option>{REPORTER_ROLES.map((r) => <option key={r} value={r}>{t(`role.${r}`)}</option>)}
            </Select>
          </FilterField>
          <FilterField label={t('filter.worker')} htmlFor="f-worker">
            <SearchBox id="f-worker" value={f.worker} onSearch={(worker) => set({ worker })} placeholder={t('filter.workerPlaceholder')} />
          </FilterField>
          <FilterField label={t('queue.from')} htmlFor="f-from">
            <Input id="f-from" type="date" value={f.from} max={f.to || undefined} onChange={(e) => set({ from: e.target.value })} />
          </FilterField>
          <FilterField label={t('queue.to')} htmlFor="f-to">
            <Input id="f-to" type="date" value={f.to} min={f.from || undefined} onChange={(e) => set({ to: e.target.value })} />
          </FilterField>
          {view !== 'closed' && (
            <div className="flex items-end pb-2.5"><Checkbox label={t('filter.overdue')} checked={f.overdue === '1'} onChange={(v) => set({ overdue: v ? '1' : '' })} /></div>
          )}
        </div>
      )}

      <FilterChips chips={chips} onClearAll={clearAll} />
      {tickets !== null && <p className="text-[13px] text-muted" role="status">{t('filter.results', { count: total })}</p>}

      {error && <Alert tone="bad">{error}</Alert>}
      {tickets === null ? <Skeleton className="h-60" /> : tickets.length === 0 ? (
        <EmptyState title={t('queue.nothing')} body={filtering ? t('queue.noFilter') : t('queue.noView')}
          action={filtering ? <Button variant="secondary" onClick={clearAll}>{t('queue.clearFilters')}</Button> : undefined} />
      ) : (
        <>
          <TicketList>
            {tickets.map((x) => <TicketRow key={x.id} ticket={x} to={`/staff/t/${x.id}`} showReporter
              extra={x.status === 'InProgress' && x.proposal?.state === 'approved' ? <Badge tone="ok">{t('queue.approved')}</Badge> : undefined} />)}
          </TicketList>
          <Pager page={page} pageCount={pageCount} total={total} pageSize={pageSize} onPage={setPage} onPageSize={setPageSize} />
        </>
      )}
    </Stack>
  )
}
/** A count that, when tapped, filters the list to those requests. */
function Stat({ label, value, tone, onClick }: { label: string; value: number; tone?: 'bad'; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="rounded-lg border border-line bg-surface px-4 py-3 text-left transition-colors hover:border-accent/40 hover:bg-subtle">
      <p className={`text-[24px] font-semibold ${tone === 'bad' ? 'text-bad' : ''}`}>{value}</p>
      <p className="text-[13px] text-muted">{label}</p>
    </button>
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
    <Card title={<span className="inline-flex items-center gap-2 text-warn"><AlertTriangle size={17} /> {t('queue.messagesNeed', { count: items.length })}</span>}>
      <ul className="divide-y divide-line">
        {items.slice(0, 6).map((n) => (
          <li key={n.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-[14px]">
            <span className="min-w-0">
              {n.ticketId ? <Link to={`/staff/t/${n.ticketId}`} className="token font-semibold text-accent">{n.ticketToken}</Link> : '-'} · {t('queue.messageTo', { channel: t(`channel.${n.channel}` as TKey), recipient: n.recipient })}
              <span className="block text-[13px] text-muted">{n.lastError ?? t('queue.deliveryFailed')}</span>
            </span>
            {can('ticket.assign') && (
              <span className="flex gap-2">
                <Button size="sm" variant="secondary" onClick={() => act(n.id, 'retry')}>{t('queue.retry')}</Button>
                <Button size="sm" variant="ghost" onClick={() => act(n.id, 'dismiss')}>{t('queue.handledCall')}</Button>
              </span>
            )}
          </li>
        ))}
      </ul>
    </Card>
  )
}

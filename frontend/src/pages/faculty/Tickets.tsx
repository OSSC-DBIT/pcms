import { useState, type ReactNode } from 'react'
import { FilterChips, FilterField, FilterToggle, SearchBox, useUrlFilters, type Chip } from '../../components/Filters'
import { Pager } from '../../components/Pager'
import { TicketList, TicketRow } from '../../components/ticket'
import { Alert, EmptyState, PageHeader, Select, Skeleton, Stack, Tabs } from '../../components/ui'
import { categories, categoryName } from '../../lib/catalog'
import { useT, type TKey } from '../../lib/i18n'
import { useTickets } from '../../lib/useTickets'
import { IMPACTS, TERMINAL, type Impact, type Status, type TicketSort } from '../../lib/types'

const OPEN_STATUSES: Status[] = ['Submitted', 'Triaged', 'Assigned', 'InProgress', 'OnHold', 'AwaitingApproval', 'Resolved']
const KEYS = ['tab', 'q', 'status', 'severity', 'type', 'sort'] as const

export default function Tickets() {
  const { t, lang } = useT()
  const { values: f, set, clear } = useUrlFilters(KEYS)
  const tab = f.tab === 'closed' ? 'closed' : 'open'
  const [panel, setPanel] = useState(false)
  // The server owns every filter, so the page count matches what is on screen.
  const { tickets, error, total, page, pageSize, pageCount, setPage, setPageSize } = useTickets('mine', {
    open: f.status ? undefined : tab === 'open',
    status: f.status ? [f.status as Status] : undefined,
    search: f.q || undefined,
    severity: (f.severity as Impact) || undefined,
    category: f.type || undefined,
    sort: (f.sort || 'newest') as TicketSort,
  })
  const cat = f.type ? categories().find((c) => c.code === f.type) : undefined
  const defs: [typeof KEYS[number], ReactNode][] = [
    ['status', f.status && t(`status.${f.status}` as TKey)],
    ['severity', f.severity && t(`impact.${f.severity}` as TKey)],
    ['type', cat && categoryName(cat, lang)],
  ]
  const chips: Chip[] = defs.filter(([, l]) => !!l).map(([key, label]) => ({ key, label, onRemove: () => set({ [key]: '' }) }))
  const filtering = chips.length > 0 || !!f.q
  const shown = tickets ?? []

  return (
    <Stack>
      <PageHeader title={t('nav.tickets')} />
      <Tabs label={t('tickets.filter')} value={tab} onChange={(v) => set({ tab: v === 'open' ? '' : v, status: '' })}
        tabs={[{ value: 'open', label: t('tickets.open') }, { value: 'closed', label: t('tickets.closed') }]} />
      <div className="flex flex-wrap items-center gap-2">
        <SearchBox id="mine-search" value={f.q} onSearch={(q) => set({ q })} placeholder={t('filter.searchMine')} />
        <FilterToggle open={panel} count={chips.length} onClick={() => setPanel((v) => !v)} />
        <label htmlFor="mine-sort" className="sr-only">{t('queue.sort')}</label>
        <Select id="mine-sort" className="w-auto flex-1 sm:flex-none" value={f.sort || 'newest'} onChange={(e) => set({ sort: e.target.value === 'newest' ? '' : e.target.value })}>
          <option value="newest">{t('queue.newest')}</option>
          <option value="oldest">{t('queue.oldest')}</option>
          <option value="updated">{t('queue.recentlyUpdated')}</option>
        </Select>
      </div>
      {panel && (
        <div className="grid gap-3 rounded-lg border border-line bg-surface p-4 sm:grid-cols-3">
          <FilterField label={t('filter.status')} htmlFor="m-status">
            <Select id="m-status" value={f.status} onChange={(e) => set({ status: e.target.value })}>
              <option value="">{t('common.any')}</option>
              {(tab === 'closed' ? TERMINAL : OPEN_STATUSES).map((s) => <option key={s} value={s}>{t(`status.${s}`)}</option>)}
            </Select>
          </FilterField>
          <FilterField label={t('queue.severity')} htmlFor="m-severity">
            <Select id="m-severity" value={f.severity} onChange={(e) => set({ severity: e.target.value })}>
              <option value="">{t('common.any')}</option>{IMPACTS.map((v) => <option key={v} value={v}>{t(`impact.${v}`)}</option>)}
            </Select>
          </FilterField>
          <FilterField label={t('queue.type')} htmlFor="m-type">
            <Select id="m-type" value={f.type} onChange={(e) => set({ type: e.target.value })}>
              <option value="">{t('common.all')}</option>{categories().map((c) => <option key={c.code} value={c.code}>{categoryName(c, lang)}</option>)}
            </Select>
          </FilterField>
        </div>
      )}
      <FilterChips chips={chips} onClearAll={() => clear(['tab', 'sort'])} />
      {error && <Alert tone="bad">{error}</Alert>}
      {tickets === null ? <Skeleton className="h-40" />
        : shown.length === 0 ? <EmptyState title={t('tickets.empty')} body={filtering ? t('queue.noFilter') : undefined} />
          : (
            <>
              <TicketList>{shown.map((x) => <TicketRow key={x.id} ticket={x} to={`/t/${x.id}`} />)}</TicketList>
              <Pager page={page} pageCount={pageCount} total={total} pageSize={pageSize} onPage={setPage} onPageSize={setPageSize} />
            </>
          )}
    </Stack>
  )
}

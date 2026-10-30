/**
 * Operational dashboard, the annual maintenance overview and download exports.
 * Every number comes from the server (GET /reports, /reports/annual); the browser
 * only draws what it receives, so Admin, facility manager and management screens
 * always agree. Only people with queue.view see this page.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown, Download } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Alert, Button, Card, PageHeader, Select, Skeleton, Stack, errorMessage } from '../../components/ui'
import { fmtDate } from '../../components/ticket'
import { api, formatPaise } from '../../lib/api'
import { building, buildingName, buildings, categories, categoryName } from '../../lib/catalog'
import { LOCALE, useT, type TFunc, type TKey } from '../../lib/i18n'
import { saveBlob } from '../../lib/http'
import type { AnnualReport, LowRating, MonthPoint, Report } from '../../lib/types'

const WINDOWS = [7, 30, 90, 180, 365]
const EXPORT_LABEL: Record<string, TKey> = {
  csv: 'reports.exportCsv', xlsx: 'reports.exportXlsx', pdf: 'reports.exportPdf',
}

/** The server groups by raw status name; this is the same wording the ticket list uses. */
const STATUS_LABEL: Record<string, TKey> = {
  Submitted: 'reports.statusSubmitted', Triaged: 'reports.statusTriaged', Assigned: 'reports.statusAssigned',
  InProgress: 'reports.statusInProgress', OnHold: 'reports.statusOnHold',
  AwaitingApproval: 'reports.statusAwaitingApproval', Resolved: 'reports.statusResolved',
}

/** Median and p90 come back as hours; show them the way a person would say them. */
function hours(h: number | null, t: TFunc): string {
  if (h === null) return '-'
  if (h < 1) return `${Math.round(h * 60)} ${t('common.min')}`
  if (h < 48) return `${Math.round(h * 10) / 10} ${t('common.hours')}`
  return `${Math.round((h / 24) * 10) / 10} ${t('common.days')}`
}

export default function Reports() {
  const { t, lang } = useT()
  const [days, setDays] = useState(30)
  const [place, setPlace] = useState('')
  const [dept, setDept] = useState('')
  const [type, setType] = useState('')
  const [data, setData] = useState<Report | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [exporting, setExporting] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement | null>(null)

  const load = useCallback(async () => {
    setError(null)
    setBusy(true)
    try {
      setData(await api.report({ days, building: place || undefined, department: dept || undefined, category: type || undefined }))
    } catch (e) { setError(errorMessage(e)) } finally { setBusy(false) }
  }, [days, place, dept, type])

  useEffect(() => { void load() }, [load])

  const placeData = place ? building(place) : null
  const deptOptions = placeData?.departments ?? []

  useEffect(() => {
    if (!menuOpen) return
    const close = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [menuOpen])

  async function runExport(format: string) {
    setMenuOpen(false)
    setExporting(format)
    setError(null)
    try {
      const filters = { days, building: place || undefined, department: dept || undefined, category: type || undefined }
      const r = await (format === 'csv' ? api.exportTicketsCsv(filters)
        : format === 'xlsx' ? api.exportTicketsXlsx(filters)
          : api.exportTicketsPdf(filters))
      saveBlob(r.blob, r.filename)
    } catch (e) { setError(errorMessage(e)) } finally { setExporting(null) }
  }

  return (
    <Stack>
      <PageHeader title={t('nav.reports')} subtitle={t('reports.subtitle')}
        actions={
          <div className="relative" ref={menuRef}>
            <Button variant="secondary" size="sm" onClick={() => setMenuOpen((v) => !v)} aria-expanded={menuOpen}
              aria-haspopup="menu" loading={exporting !== null}>
              <Download size={16} /> {exporting ? t(EXPORT_LABEL[exporting]) : t('reports.export')} <ChevronDown size={14} />
            </Button>
            {menuOpen && (
              <div role="menu" className="absolute right-0 z-10 mt-1 w-60 overflow-hidden rounded-lg border border-line bg-surface shadow-md">
                {(['csv', 'xlsx', 'pdf'] as const).map((f) => (
                  <button key={f} role="menuitem" onClick={() => void runExport(f)}
                    className="flex w-full items-center justify-between px-4 py-2.5 text-left text-[14px] hover:bg-subtle">
                    <span>{t(EXPORT_LABEL[f])}</span>
                    <span className="text-[12px] text-muted uppercase">{f}</span>
                  </button>
                ))}
                <p className="border-t border-line px-4 py-2 text-[11.5px] text-muted">{t('reports.exportNote')}</p>
              </div>
            )}
          </div>
        } />

      <div className="flex flex-wrap items-center gap-3">
        <div className="w-36">
          <Select aria-label={t('reports.window')} value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {WINDOWS.map((d) => <option key={d} value={d}>{t('reports.lastDays', { days: d })}</option>)}
          </Select>
        </div>
        <div className="w-52">
          <Select aria-label={t('queue.building')} value={place}
            onChange={(e) => { setPlace(e.target.value); setDept('') }}>
            <option value="">{t('reports.allBuildings')}</option>
            {buildings().map((b) => <option key={b.code} value={b.code}>{buildingName(b, lang)}</option>)}
          </Select>
        </div>
        {place && deptOptions.length > 0 && (
          <div className="w-52">
            <Select aria-label={t('reports.department')} value={dept} onChange={(e) => setDept(e.target.value)}>
              <option value="">{t('reports.allDepartments')}</option>
              {deptOptions.map((d) => <option key={d} value={d}>{d}</option>)}
            </Select>
          </div>
        )}
        <div className="w-52">
          <Select aria-label={t('queue.type')} value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">{t('reports.allTypes')}</option>
            {categories().map((c) => <option key={c.code} value={c.code}>{categoryName(c, lang)}</option>)}
          </Select>
        </div>
        <Button variant="ghost" size="sm" onClick={() => void load()} loading={busy}>{t('action.refresh')}</Button>
      </div>

      {error && <Alert tone="bad">{error}</Alert>}
      {!data ? <Skeleton className="h-72" /> : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label={t('reports.untriaged')} value={data.untriaged} tone={data.untriaged ? 'bad' : undefined} />
            <Stat label={t('reports.averageRating')} value={data.ratings.average === null ? '-' : data.ratings.average.toFixed(1)} />
            <Stat label={t('reports.overdue')} value={data.overdueUpdates} tone={data.overdueUpdates ? 'bad' : undefined} />
            <Stat label={t('reports.waitingApproval')} value={data.pendingApprovals} />
            <Stat label={t('reports.disputed')} value={data.disputes} />
            <Stat label={t('reports.failedMessages')} value={data.failedNotifications} tone={data.failedNotifications ? 'warn' : undefined} />
          </div>

          <AnnualOverview building={place} department={dept} category={type} />

          <RatingsCard ratings={data.ratings} />

          <div className="grid gap-4 lg:grid-cols-2">
            <Card title={t('reports.openByStatus')}>
              <Bars data={data.openByStatus} labelFor={(s) => STATUS_LABEL[s] ? t(STATUS_LABEL[s]) : s} />
            </Card>
            <Card title={t('reports.openByPriority')}>
              <Bars data={data.openByPriority} labelFor={(p) => p} />
            </Card>
          </div>

          <Card title={t('reports.repeatFaults')} subtitle={t('reports.repeatSubtitle')}>
            {data.repeatFaults.length === 0
              ? <p className="text-[14px] text-muted">{t('reports.noRepeats')}</p>
              : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-[14px]">
                    <thead><tr className="border-b border-line text-[13px] text-muted">
                      <th scope="col" className="py-2 pr-3 font-medium">{t('reports.place')}</th>
                      <th scope="col" className="py-2 pr-3 font-medium">{t('reports.type')}</th>
                      <th scope="col" className="py-2 text-right font-medium">{t('reports.count')}</th>
                    </tr></thead>
                    <tbody>
                      {data.repeatFaults.map((f, i) => (
                        <tr key={`${f.building}-${f.room}-${f.category}-${i}`} className="border-b border-line last:border-b-0">
                          <td className="py-2 pr-3">{[f.building ? buildingName(building(f.building) ?? { code: f.building, nameEn: f.building, nameHi: f.building, nameKn: f.building, floors: [], departments: [], departmentsKn: [], active: false }, lang) : f.building, f.room].filter(Boolean).join(', ') || t('ticket.outdoors')}</td>
                          <td className="py-2 pr-3">{(() => { const c = categories().find((x) => x.code === f.category); return c ? categoryName(c, lang) : (f.category ?? '-') })()}</td>
                          <td className="py-2 text-right font-medium">{f.count}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
          </Card>

          {data.holdsByReason.length > 0 && (
            <Card title={t('reports.postponedByReason')}>
              <Bars data={Object.fromEntries(data.holdsByReason.map((h) => [h.reason ?? t('reports.noReason'), h.count]))} labelFor={(r) => r} />
            </Card>
          )}

          <div className="grid gap-3 sm:grid-cols-3">
            <Card title={t('reports.timeToTriage')}><p className="text-[15px]">{t('reports.median')} <b>{hours(data.triageTime.medianHours, t)}</b></p><p className="mt-1 text-[13px] text-muted">{t('reports.within', { time: hours(data.triageTime.p90Hours, t), count: data.triageTime.count })}</p></Card>
            <Card title={t('reports.timeToResolve')}><p className="text-[15px]">{t('reports.median')} <b>{hours(data.resolutionTime.medianHours, t)}</b></p><p className="mt-1 text-[13px] text-muted">{t('reports.within', { time: hours(data.resolutionTime.p90Hours, t), count: data.resolutionTime.count })}</p></Card>
            <Card title={t('reports.approvedSpend')}><p className="text-[15px] font-semibold">{formatPaise(data.approvedPaise)}</p><p className="mt-1 text-[13px] text-muted">{t('reports.approvedByManagement')}</p></Card>
          </div>

          <p className="text-[12.5px] text-muted">{t('common.generated', { date: new Date(data.generatedAt).toLocaleString(LOCALE[lang], { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' }) })}</p>
        </>
      )}
    </Stack>
  )
}

/**
 * Annual maintenance overview for one calendar year, from ticket data the
 * server has already grouped in Asia/Kolkata months.
 */
function AnnualOverview({ building: b, department, category }: { building: string; department: string; category: string }) {
  const { t, lang } = useT()
  const [year, setYear] = useState<number | undefined>(undefined)
  const [annual, setAnnual] = useState<AnnualReport | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      setAnnual(await api.annualReport({ year, building: b || undefined, department: department || undefined, category: category || undefined }))
    } catch (e) { setError(errorMessage(e)) }
  }, [year, b, department, category])

  useEffect(() => { void load() }, [load])

  const monthFmt = new Intl.DateTimeFormat(LOCALE[lang], { month: 'short' })
  const labels = Array.from({ length: 12 }, (_, i) => monthFmt.format(new Date(0, i)))
  const months = annual?.months ?? []
  const createdThis = months.reduce((s, m) => s + m.created, 0)
  const resolvedThis = months.reduce((s, m) => s + m.resolved, 0)
  const createdPrev = (annual?.previousCreated ?? []).reduce((s, n) => s + n, 0)
  const resolvedPrev = (annual?.previousResolved ?? []).reduce((s, n) => s + n, 0)
  const pending = months.reduce((s, m) => s + m.pending, 0)
  const overdue = months.reduce((s, m) => s + m.overdue, 0)
  // One year-level average: each month's mean weight by how many were resolved then.
  let avg = null as number | null
  {
    let total = 0, n = 0
    for (const m of months) {
      if (m.avgResolutionHours !== null && m.resolved > 0) { total += m.avgResolutionHours * m.resolved; n += m.resolved }
    }
    if (n > 0) avg = Math.round((total / n) * 10) / 10
  }

  return (
    <Card title={t('reports.annual')} subtitle={t('reports.annualSubtitle')}
      actions={annual && annual.years.length > 0 && (
        <div className="w-28">
          <Select aria-label={t('reports.year')} value={annual.year}
            onChange={(e) => setYear(Number(e.target.value))}>
            {annual.years.map((y) => <option key={y} value={y}>{y}</option>)}
          </Select>
        </div>
      )}>
      {error && <Alert tone="bad">{error}</Alert>}
      {!annual ? <Skeleton className="h-40" /> : annual.years.length === 0 ? (
        <p className="text-[14px] text-muted">{t('reports.annualEmpty')}</p>
      ) : (
        <Stack>
          <div className="flex justify-end gap-5 text-[13px] text-muted">
            <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-full bg-accent" aria-hidden /> {t('reports.legendCreated')}</span>
            <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-full bg-warn" aria-hidden /> {t('reports.legendResolved')}</span>
          </div>
          <MonthChart months={months} labels={labels} />
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            <Stat label={`${t('reports.legendCreated')} (${annual.year})`} value={createdThis} />
            <Stat label={`${t('reports.legendResolved')} (${annual.year})`} value={resolvedThis} />
            <Stat label={t('reports.monthPending')} value={pending} tone={pending ? 'warn' : undefined} />
            <Stat label={t('reports.monthOverdue')} value={overdue} tone={overdue ? 'bad' : undefined} />
            <Stat label={t('reports.avgResolution')} value={avg === null ? '-' : hours(avg, t)} />
          </div>
          <p className="text-[13px] text-muted">
            {t('reports.annualCompare', { created: createdThis, prevCreated: createdPrev, resolved: resolvedThis, prevResolved: resolvedPrev })}
          </p>
        </Stack>
      )}
    </Card>
  )
}

/** Grouped CSS bars, two per month, in the order the server sent them. */
function MonthChart({ months, labels }: { months: MonthPoint[]; labels: string[] }) {
  const max = Math.max(1, ...months.map((m) => Math.max(m.created, m.resolved)))
  return (
    <ul className="flex items-end gap-1.5 sm:gap-2">
      {months.map((m, i) => (
        <li key={m.month} className="flex flex-1 flex-col items-center gap-1">
          <div className="flex h-28 w-full items-end justify-center gap-[2px]">
            <span className="w-1/2 max-w-[12px] rounded-t bg-accent" style={{ height: `${m.created === 0 ? 0 : Math.max(4, (m.created / max) * 100)}%` }}
              aria-label={`${labels[i]} ${m.created}`} />
            <span className="w-1/2 max-w-[12px] rounded-t bg-warn" style={{ height: `${m.resolved === 0 ? 0 : Math.max(4, (m.resolved / max) * 100)}%` }}
              aria-label={`${labels[i]} ${m.resolved}`} />
          </div>
          <span className="text-[10.5px] text-muted">{labels[i]}</span>
        </li>
      ))}
    </ul>
  )
}

function Stat({ label, value, tone }: { label: string; value: string | number; tone?: 'bad' | 'warn' }) {
  return (
    <div className="rounded-lg border border-line bg-surface px-4 py-3">
      <p className={`text-[24px] font-semibold ${tone === 'bad' ? 'text-bad' : tone === 'warn' ? 'text-warn' : ''}`}>{value}</p>
      <p className="text-[13px] text-muted">{label}</p>
    </div>
  )
}

function RatingsCard({ ratings }: { ratings: Report['ratings'] }) {
  const { t } = useT()
  return (
    <Card title={t('reports.ratings')} subtitle={t('reports.ratingsSubtitle')}>
      {ratings.count === 0 ? <p className="text-[14px] text-muted">{t('reports.noRatings')}</p> : (
        <Stack>
          <p className="text-[14.5px]">
            {t('reports.ratingSummary', { count: ratings.count, average: ratings.average === null ? '-' : ratings.average.toFixed(1) })}
          </p>
          <RatingBars distribution={ratings.distribution} />
          <div>
            <p className="mb-2 text-[14px] font-medium">{t('reports.recentLow')}</p>
            {ratings.low.length === 0
              ? <p className="text-[14px] text-muted">{t('reports.noLow')}</p>
              : <LowRatingsTable rows={ratings.low} />}
          </div>
        </Stack>
      )}
    </Card>
  )
}

/** 1 and 2 star ratings only; the server sends the newest ten. */
function LowRatingsTable({ rows }: { rows: LowRating[] }) {
  const { t, lang } = useT()
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-[14px]">
        <thead><tr className="border-b border-line text-[13px] text-muted">
          <th scope="col" className="py-2 pr-3 font-medium">{t('reports.ticket')}</th>
          <th scope="col" className="py-2 pr-3 font-medium">{t('reports.stars')}</th>
          <th scope="col" className="py-2 pr-3 font-medium">{t('reports.comment')}</th>
          <th scope="col" className="py-2 text-right font-medium">{t('reports.date')}</th>
        </tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.ticketId} className="border-b border-line last:border-b-0">
              <td className="py-2 pr-3"><Link to={`/staff/t/${r.ticketId}`} className="token font-semibold text-accent">{r.token}</Link></td>
              <td className="py-2 pr-3">{t('common.of5', { value: r.stars })}</td>
              <td className="py-2 pr-3">{r.comment || '-'}</td>
              <td className="py-2 text-right text-muted">{fmtDate(r.createdAt, lang)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** Keeps the conventional 5, 4, 3, 2, 1 order; Bars sorts by count instead. */
function RatingBars({ distribution }: { distribution: Record<string, number> }) {
  const { t } = useT()
  const entries = [5, 4, 3, 2, 1].map((n) => [String(n), distribution[String(n)] ?? 0] as const)
  const max = Math.max(1, ...entries.map(([, n]) => n))
  return (
    <ul className="space-y-2.5" aria-label={t('reports.ratingDistribution')}>
      {entries.map(([stars, n]) => (
        <li key={stars} className="flex items-center gap-3 text-[13.5px]">
          <span className="w-14 shrink-0 text-muted">{t(stars === '1' ? 'time.starCount' : 'time.starCountPlural', { count: stars })}</span>
          <span className="h-2.5 flex-1 overflow-hidden rounded-full bg-subtle">
            <span className="block h-full rounded-full bg-warn" style={{ width: `${(n / max) * 100}%` }} />
          </span>
          <span className="w-8 shrink-0 text-right font-medium">{n}</span>
        </li>
      ))}
    </ul>
  )
}

/** Plain CSS bars; no chart library needed for a handful of counts. */
function Bars({ data, labelFor }: { data: Record<string, number>; labelFor: (k: string) => string }) {
  const { t } = useT()
  const entries = Object.entries(data).sort((a, b) => b[1] - a[1])
  if (!entries.length) return <p className="text-[14px] text-muted">{t('reports.nothingOpen')}</p>
  const max = Math.max(...entries.map((e) => e[1]))
  return (
    <ul className="space-y-2.5">
      {entries.map(([k, n]) => (
        <li key={k} className="flex items-center gap-3 text-[13.5px]">
          <span className="w-32 shrink-0 truncate text-muted">{labelFor(k)}</span>
          <span className="h-2.5 flex-1 overflow-hidden rounded-full bg-subtle">
            <span className="block h-full rounded-full bg-accent" style={{ width: `${Math.max(4, (n / max) * 100)}%` }} />
          </span>
          <span className="w-8 shrink-0 text-right font-medium">{n}</span>
        </li>
      ))}
    </ul>
  )
}

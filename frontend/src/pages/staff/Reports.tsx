/**
 * Operational dashboard. Everything here comes from GET /reports, which the server
 * already computes: open counts, overdue updates, repeat faults and response percentiles.
 * Only people with queue.view see this page.
 */
import { useCallback, useEffect, useState } from 'react'
import { Download } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Alert, Button, Card, PageHeader, Select, Skeleton, Stack, errorMessage } from '../../components/ui'
import { fmtDate } from '../../components/ticket'
import { api, formatPaise } from '../../lib/api'
import { building, buildings, categories } from '../../lib/catalog'
import { useT } from '../../lib/i18n'
import type { LowRating, Report } from '../../lib/types'

const WINDOWS = [7, 30, 90, 180, 365]

/** The server groups by raw status name; this is the same wording the ticket list uses. */
const STATUS_LABEL: Record<string, string> = {
  Submitted: 'New', Triaged: 'Accepted', Assigned: 'Assigned', InProgress: 'In progress', OnHold: 'Postponed',
  AwaitingApproval: 'Awaiting approval', Resolved: 'Awaiting check',
}

/** Median and p90 come back as hours; show them the way a person would say them. */
function hours(h: number | null): string {
  if (h === null) return '-'
  if (h < 1) return `${Math.round(h * 60)} min`
  if (h < 48) return `${Math.round(h * 10) / 10} h`
  return `${Math.round((h / 24) * 10) / 10} days`
}

export default function Reports() {
  const { t } = useT()
  const [days, setDays] = useState(30)
  const [place, setPlace] = useState('')
  const [kind, setKind] = useState('')
  const [data, setData] = useState<Report | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setError(null)
    setBusy(true)
    try {
      setData(await api.report({ days, building: place || undefined, category: kind || undefined }))
    } catch (e) { setError(errorMessage(e)) } finally { setBusy(false) }
  }, [days, place, kind])

  useEffect(() => { void load() }, [load])

  async function download() {
    setError(null)
    try {
      const { blob, filename } = await api.exportTicketsCsv(days)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      a.rel = 'noopener'
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (e) { setError(errorMessage(e)) }
  }

  return (
    <Stack>
      <PageHeader title={t('nav.reports')} subtitle="What the last few weeks looked like, and what is waiting."
        actions={<Button variant="secondary" size="sm" onClick={() => void download()}><Download size={16} /> Export CSV</Button>} />

      <div className="flex flex-wrap items-center gap-3">
        <div className="w-36">
          <Select aria-label="Time window" value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {WINDOWS.map((d) => <option key={d} value={d}>Last {d} days</option>)}
          </Select>
        </div>
        <div className="w-52">
          <Select aria-label="Building" value={place} onChange={(e) => setPlace(e.target.value)}>
            <option value="">All buildings</option>
            {buildings().map((b) => <option key={b.code} value={b.code}>{b.nameEn}</option>)}
          </Select>
        </div>
        <div className="w-52">
          <Select aria-label="Type" value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">All types</option>
            {categories().map((c) => <option key={c.code} value={c.code}>{c.nameEn}</option>)}
          </Select>
        </div>
        <Button variant="ghost" size="sm" onClick={() => void load()} loading={busy}>Refresh</Button>
      </div>

      {error && <Alert tone="bad">{error}</Alert>}
      {!data ? <Skeleton className="h-72" /> : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Untriaged" value={data.untriaged} tone={data.untriaged ? 'bad' : undefined} />
            <Stat label="Average rating" value={data.ratings.average === null ? '-' : data.ratings.average.toFixed(1)} />
            <Stat label="Update overdue" value={data.overdueUpdates} tone={data.overdueUpdates ? 'bad' : undefined} />
            <Stat label="Waiting approval" value={data.pendingApprovals} />
            <Stat label="Disputed" value={data.disputes} />
            <Stat label="Failed messages" value={data.failedNotifications} tone={data.failedNotifications ? 'warn' : undefined} />
          </div>

          <RatingsCard ratings={data.ratings} />

          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Open tickets by status">
              <Bars data={data.openByStatus} labelFor={(s) => STATUS_LABEL[s] ?? s} />
            </Card>
            <Card title="Open tickets by priority">
              <Bars data={data.openByPriority} labelFor={(p) => p} />
            </Card>
          </div>

          <Card title="Repeat faults" subtitle="Places and types reported more than once">
            {data.repeatFaults.length === 0
              ? <p className="text-[14px] text-muted">No repeats in this window.</p>
              : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-[14px]">
                    <thead><tr className="border-b border-line text-[13px] text-muted">
                      <th scope="col" className="py-2 pr-3 font-medium">Place</th>
                      <th scope="col" className="py-2 pr-3 font-medium">Type</th>
                      <th scope="col" className="py-2 text-right font-medium">Reports</th>
                    </tr></thead>
                    <tbody>
                      {data.repeatFaults.map((f, i) => (
                        <tr key={`${f.building}-${f.room}-${f.category}-${i}`} className="border-b border-line last:border-b-0">
                          <td className="py-2 pr-3">{[building(f.building ?? '')?.nameEn ?? f.building, f.room].filter(Boolean).join(', ') || 'Outdoors'}</td>
                          <td className="py-2 pr-3">{categories().find((c) => c.code === f.category)?.nameEn ?? f.category ?? '-'}</td>
                          <td className="py-2 text-right font-medium">{f.count}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
          </Card>

          {data.holdsByReason.length > 0 && (
            <Card title="Postponed, by reason">
              <Bars data={Object.fromEntries(data.holdsByReason.map((h) => [h.reason ?? 'No reason given', h.count]))} labelFor={(r) => r} />
            </Card>
          )}

          <div className="grid gap-3 sm:grid-cols-3">
            <Card title="Time to triage"><p className="text-[15px]">Median <b>{hours(data.triageTime.medianHours)}</b></p><p className="mt-1 text-[13px] text-muted">90% within {hours(data.triageTime.p90Hours)} · {data.triageTime.count} ticket(s)</p></Card>
            <Card title="Time to resolve"><p className="text-[15px]">Median <b>{hours(data.resolutionTime.medianHours)}</b></p><p className="mt-1 text-[13px] text-muted">90% within {hours(data.resolutionTime.p90Hours)} · {data.resolutionTime.count} ticket(s)</p></Card>
            <Card title="Approved spend"><p className="text-[15px] font-semibold">{formatPaise(data.approvedPaise)}</p><p className="mt-1 text-[13px] text-muted">Approved by management in this window</p></Card>
          </div>

          <p className="text-[12.5px] text-muted">Generated {new Date(data.generatedAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' })} IST</p>
        </>
      )}
    </Stack>
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
  return (
    <Card title="Ratings" subtitle="Given by reporters after a repair is closed">
      {ratings.count === 0 ? <p className="text-[14px] text-muted">No ratings in this window.</p> : (
        <Stack>
          <p className="text-[14.5px]">
            <b>{ratings.count}</b> rating(s) · average <b>{ratings.average === null ? '-' : ratings.average.toFixed(1)}</b> of 5
          </p>
          <RatingBars distribution={ratings.distribution} />
          <div>
            <p className="mb-2 text-[14px] font-medium">Recent low ratings</p>
            {ratings.low.length === 0
              ? <p className="text-[14px] text-muted">No low ratings in this window.</p>
              : <LowRatingsTable rows={ratings.low} />}
          </div>
        </Stack>
      )}
    </Card>
  )
}

/** 1 and 2 star ratings only; the server sends the newest ten. */
function LowRatingsTable({ rows }: { rows: LowRating[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-[14px]">
        <thead><tr className="border-b border-line text-[13px] text-muted">
          <th scope="col" className="py-2 pr-3 font-medium">Ticket</th>
          <th scope="col" className="py-2 pr-3 font-medium">Stars</th>
          <th scope="col" className="py-2 pr-3 font-medium">Comment</th>
          <th scope="col" className="py-2 text-right font-medium">Date</th>
        </tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.ticketId} className="border-b border-line last:border-b-0">
              <td className="py-2 pr-3"><Link to={`/staff/t/${r.ticketId}`} className="token font-semibold text-accent">{r.token}</Link></td>
              <td className="py-2 pr-3">{r.stars} / 5</td>
              <td className="py-2 pr-3">{r.comment || '-'}</td>
              <td className="py-2 text-right text-muted">{fmtDate(r.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** Keeps the conventional 5, 4, 3, 2, 1 order; Bars sorts by count instead. */
function RatingBars({ distribution }: { distribution: Record<string, number> }) {
  const entries = [5, 4, 3, 2, 1].map((n) => [String(n), distribution[String(n)] ?? 0] as const)
  const max = Math.max(1, ...entries.map(([, n]) => n))
  return (
    <ul className="space-y-2.5" aria-label="Rating distribution">
      {entries.map(([stars, n]) => (
        <li key={stars} className="flex items-center gap-3 text-[13.5px]">
          <span className="w-14 shrink-0 text-muted">{stars} star{stars === '1' ? '' : 's'}</span>
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
  const entries = Object.entries(data).sort((a, b) => b[1] - a[1])
  if (!entries.length) return <p className="text-[14px] text-muted">Nothing open.</p>
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

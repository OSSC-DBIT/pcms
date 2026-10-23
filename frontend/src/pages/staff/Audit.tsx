/**
 * Audit trail viewer. The log is append-only in the database, so this page only ever
 * reads it, and pages backwards with a cursor instead of an offset.
 */
import { useCallback, useEffect, useState } from 'react'
import { useT } from '../../lib/i18n'
import { api } from '../../lib/api'
import { Alert, Button, EmptyState, Input, PageHeader, Skeleton, Stack, errorMessage } from '../../components/ui'
import type { AuditEvent } from '../../lib/types'

const PAGE = 100
const IST: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' }

export default function Audit() {
  const { t } = useT()
  const [action, setAction] = useState('')
  const [entity, setEntity] = useState('')
  const [rows, setRows] = useState<AuditEvent[] | null>(null)
  const [more, setMore] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async (cursor?: number, append = false) => {
    setError(null)
    setLoading(true)
    try {
      const page = await api.auditLog({
        action: action.trim() || undefined,
        entityId: entity.trim() || undefined,
        beforeId: cursor,
        limit: PAGE,
      })
      setRows((prev) => append && prev ? [...prev, ...page] : page)
      // The oldest row's id is the cursor for the next page backwards.
      setMore(page.length === PAGE ? (page[page.length - 1]?.id ?? null) : null)
    } catch (e) { setError(errorMessage(e)); if (!append) setRows([]) } finally { setLoading(false) }
  }, [action, entity])

  // Debounce so typing does not fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => void load(), 250)
    return () => clearTimeout(t)
  }, [load])

  return (
    <Stack>
      <PageHeader title={t('nav.audit')} subtitle="Every recorded change, newest first. This log cannot be edited or deleted." />
      <div className="flex flex-wrap gap-3">
        <div className="w-full sm:w-64">
          <Input value={action} onChange={(e) => setAction(e.target.value)} placeholder="Action, e.g. ticket" aria-label="Filter by action" />
        </div>
        <div className="w-full sm:w-64">
          <Input value={entity} onChange={(e) => setEntity(e.target.value)} placeholder="Entity ID, e.g. a token or UUID" aria-label="Filter by entity" />
        </div>
      </div>
      {error && <Alert tone="bad">{error}</Alert>}
      {rows === null ? <Skeleton className="h-72" /> : rows.length === 0 ? (
        <EmptyState title="Nothing recorded" body="No audit entries match these filters." />
      ) : (
        <>
          <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
            {rows.map((r) => <Row key={r.id} ev={r} />)}
          </ul>
          {more !== null && (
            <div className="flex justify-center">
              <Button variant="secondary" loading={loading} onClick={() => void load(more, true)}>Load older entries</Button>
            </div>
          )}
        </>
      )}
    </Stack>
  )
}

function Row({ ev }: { ev: AuditEvent }) {
  const change = diffLine(ev)
  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <code className="token text-[13px] font-semibold text-accent">{ev.action}</code>
        <span className="text-[13px] text-muted">{ev.entityType} {ev.entityId}</span>
        <span className="ml-auto text-[12.5px] text-muted">{new Date(ev.at).toLocaleString('en-IN', IST)}</span>
      </div>
      <p className="mt-0.5 text-[13.5px]">{ev.actorLabel}{ev.delegatedWorker && <span className="text-muted"> (for {ev.delegatedWorker})</span>}</p>
      {change && <p className="token mt-1 break-words text-[12.5px] text-muted">{change}</p>}
      {ev.reason && <p className="mt-1 text-[13.5px]">{ev.reason}</p>}
      {ev.requestId && <p className="mt-0.5 text-[12px] text-muted">Request {ev.requestId}</p>}
    </li>
  )
}

/** "before -> after" for the handful of keys worth showing; full detail is in the JSON. */
function diffLine(ev: AuditEvent): string | null {
  const before = ev.before ?? {}
  const after = ev.after ?? {}
  const keys = Array.from(new Set([...Object.keys(before), ...Object.keys(after)])).slice(0, 4)
  if (!keys.length) return null
  const bits = keys.map((k) => {
    const b = before[k]
    const a = after[k]
    const fmt = (v: unknown) => v === undefined || v === null ? '-' : typeof v === 'object' ? JSON.stringify(v) : String(v)
    return `${k}: ${fmt(b)} -> ${fmt(a)}`
  })
  return bits.join(' · ')
}

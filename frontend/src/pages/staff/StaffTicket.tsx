/**
 * Staff ticket page. The highlighted card is always the next step of the flow DBIT confirmed:
 *   1. Review: accept (with priority) or reject with a reason.
 *   2. Assign a worker: an SMS is sent to them automatically.
 *   3. After the worker looks at it, choose the flag:
 *        I Immediate  -> fix it now, then mark as fixed
 *        C Critical   -> send to institute management (reason, optional cost)
 *        P Postpone   -> on hold with a reason and review date
 *   4. Management decides critical tickets; the reporter confirms the fix.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import { AlertTriangle, ArrowLeft, Clock, MessageSquare, Phone, Wrench } from 'lucide-react'
import { useAuth } from '../../App'
import { ActionDialog, type FormField } from '../../components/ActionDialog'
import { Gallery, Messages, TicketSummaryCard, Timeline, ago } from '../../components/ticket'
import { Alert, Badge, Button, Card, Chips, Field, Input, Spinner, Stack, Textarea, errorMessage } from '../../components/ui'
import { api, formatPaise, HttpError, parseRupees, type TransitionAction } from '../../lib/api'
import { categories, category } from '../../lib/catalog'
import { TERMINAL, type Channel, type DecisionKind, type Priority, type Ticket, type Worker } from '../../lib/types'

type Run = (fn: () => Promise<Ticket>) => Promise<boolean>
interface Action { key: string; label: string; danger?: boolean; fields: FormField[]; description?: string; build: (v: Record<string, string>) => TransitionAction }

export default function StaffTicket() {
  const { id } = useParams()
  const { user, can } = useAuth()
  const [ticket, setTicket] = useState<Ticket | null | undefined>(undefined)
  const [workers, setWorkers] = useState<Worker[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [dialog, setDialog] = useState<Action | null>(null)

  const load = useCallback(async () => { if (id) setTicket(await api.getTicket(id)) }, [id])
  useEffect(() => {
    load().catch(() => setTicket(null))
    if (can('worker.directory')) api.listWorkers({ active: true }).then(setWorkers).catch(() => setWorkers([]))
  }, [load, can])

  const run: Run = useCallback(async (fn) => {
    setBusy(true); setError(null)
    try { setTicket(await fn()); return true }
    catch (e) {
      if (e instanceof HttpError && e.code === 'stale_version') { setError('Someone else changed this ticket. It has been reloaded; check and try again.'); await load() }
      else setError(errorMessage(e))
      return false
    } finally { setBusy(false) }
  }, [load])

  if (ticket === undefined) return <Spinner />
  if (ticket === null) return <p className="text-muted">Ticket not found.</p>

  const s = ticket.status
  const active = ticket.assignments.filter((a) => !a.releasedAt)
  const p = ticket.proposal
  const canDecide = can('cost.approve') && p?.state === 'pending' && p.requestedById !== user?.id && ticket.reporterId !== user?.id

  return (
    <Stack>
      <Link to="/staff" className="inline-flex items-center gap-1 text-[14px] text-accent"><ArrowLeft size={16} /> Queue</Link>
      <div className="grid gap-4 lg:grid-cols-[1fr_380px]">
        <Stack>
          <TicketSummaryCard ticket={ticket}>
            <div className="mt-3 flex flex-wrap gap-2">
              <Badge>Priority {ticket.priority}</Badge>
              {ticket.flag && <Badge tone={ticket.flag === 'C' ? 'bad' : ticket.flag === 'P' ? 'warn' : 'ok'}>{FLAG_LABEL[ticket.flag]}</Badge>}
              {ticket.originalCategoryCode !== ticket.categoryCode && <Badge>Reported as {category(ticket.originalCategoryCode).nameEn}</Badge>}
              <Badge>Age {ago(ticket.createdAt).replace(' ago', '')}</Badge>
            </div>
            {(ticket.accessNote || ticket.altContact) && (
              <p className="mt-3 text-[14px]">{ticket.accessNote && <>Access: {ticket.accessNote}. </>}{ticket.altContact && <>Contact: {ticket.altContact}</>}</p>
            )}
            {s === 'OnHold' && ticket.holdReason && <div className="mt-3"><Alert tone="warn" title="Postponed">{ticket.holdReason}{ticket.holdReviewDate && ` · review ${ticket.holdReviewDate}`}</Alert></div>}
          </TicketSummaryCard>

          {error && <Alert tone="bad">{error}</Alert>}

          {can('ticket.triage') && s === 'Submitted' && <ReviewStep ticket={ticket} busy={busy} run={run} />}
          {can('ticket.assign') && (s === 'Triaged' || (s === 'OnHold' && active.length === 0)) && <AssignStep ticket={ticket} workers={workers} busy={busy} run={run} />}
          {active.length > 0 && <AssignmentsCard ticket={ticket} busy={busy} run={run} canAssign={can('ticket.assign')} />}
          {can('ticket.triage') && (s === 'Assigned' || s === 'InProgress') && <FlagStep ticket={ticket} busy={busy} run={run} managerName={user?.name ?? 'Facilities'} />}
          {can('ticket.assign') && s === 'OnHold' && active.length > 0 && (
            <Next title="Ready to continue?"><Button loading={busy} onClick={() => run(() => api.transition(ticket, { action: 'resume' }))}>Resume work</Button></Next>
          )}
          {s === 'AwaitingApproval' && !canDecide && <Alert tone="info" title="Waiting for institute management">Marked critical and sent for a decision.</Alert>}
          {p && <ManagementCard ticket={ticket} busy={busy} run={run} canDecide={!!canDecide} />}
          {s === 'Resolved' && <Alert tone="info" title="Waiting for the reporter to check the work">They can confirm it is fixed or say it is still broken.</Alert>}

          <Card title="Photos and video"><Gallery ticket={ticket} canAdd={!TERMINAL.includes(s)} onChanged={load} /></Card>
        </Stack>

        <Stack>
          <MoreActions ticket={ticket} onPick={setDialog} />
          <Card title="Messages and notes">
            <Messages staff comments={ticket.comments} onSend={async (body, internal) => { setTicket(await api.addComment(ticket, body, internal)) }} />
          </Card>
          <Card title="History"><Timeline events={ticket.events} /></Card>
        </Stack>
      </div>

      {dialog && (
        <ActionDialog open title={dialog.label} description={dialog.description} fields={dialog.fields} confirmLabel={dialog.label} danger={dialog.danger}
          onClose={() => setDialog(null)} onSubmit={async (v) => setTicket(await api.transition(ticket, dialog.build(v)))} />
      )}
    </Stack>
  )
}

const FLAG_LABEL = { I: 'I · Immediate', C: 'C · Critical', P: 'P · Postponed' } as const

function Next({ title, children }: { title: string; children: ReactNode }) {
  return <Card title={title} className="border-accent/40 ring-1 ring-accent/20">{children}</Card>
}

// ---------- 1. review ----------

function ReviewStep({ ticket, busy, run }: { ticket: Ticket; busy: boolean; run: Run }) {
  const [priority, setPriority] = useState<Priority>(ticket.priority)
  const [rejecting, setRejecting] = useState(false)
  const [reason, setReason] = useState('')
  return (
    <Next title="Step 1: Accept or reject this report">
      <Stack>
        <div>
          <p className="mb-1.5 text-[14px] font-medium">Priority</p>
          <Chips label="Priority" value={priority} onChange={setPriority} options={[
            { value: 'P1', label: 'P1 Critical' }, { value: 'P2', label: 'P2 High' }, { value: 'P3', label: 'P3 Normal' }, { value: 'P4', label: 'P4 Low' }]} />
        </div>
        {!rejecting ? (
          <div className="flex flex-wrap gap-2">
            <Button loading={busy} onClick={() => run(() => api.transition(ticket, { action: 'triage', priority }))}>Accept</Button>
            <Button variant="danger" onClick={() => setRejecting(true)}>Reject</Button>
          </div>
        ) : (
          <Stack>
            <Field label="Reason for rejecting" hint="The reporter sees this">
              {(id, d) => <Textarea id={id} aria-describedby={d} rows={2} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />}
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button variant="danger" loading={busy} disabled={!reason.trim()} onClick={() => run(() => api.transition(ticket, { action: 'reject', reason: reason.trim() }))}>Reject report</Button>
              <Button variant="ghost" onClick={() => setRejecting(false)}>Back</Button>
            </div>
          </Stack>
        )}
      </Stack>
    </Next>
  )
}

// ---------- 2. assign ----------

function AssignStep({ ticket, workers, busy, run }: { ticket: Ticket; workers: Worker[]; busy: boolean; run: Run }) {
  const [all, setAll] = useState(false)
  const [picked, setPicked] = useState<string[]>([])
  const [channel, setChannel] = useState<Channel>('sms')
  const list = useMemo(() => workers.filter((w) => all || w.trades.includes(ticket.categoryCode)), [workers, all, ticket.categoryCode])
  const chosen = workers.filter((w) => picked.includes(w.id))
  const noWhatsApp = channel === 'whatsapp' && chosen.some((w) => w.mode !== 'whatsapp')
  return (
    <Next title="Step 2: Assign a worker">
      <Stack>
        {list.length === 0 && <Alert tone="warn">No active worker for {category(ticket.categoryCode).nameEn}. Show all workers, or add one in Workers.</Alert>}
        <div className="grid gap-2 sm:grid-cols-2">
          {list.map((w) => (
            <label key={w.id} className={`flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2.5 ${picked.includes(w.id) ? 'border-accent bg-accent-soft' : 'border-line'}`}>
              <input type="checkbox" className="mt-1 h-4 w-4 accent-[var(--c-accent)]" checked={picked.includes(w.id)}
                onChange={() => setPicked((x) => x.includes(w.id) ? x.filter((y) => y !== w.id) : [...x, w.id])} />
              <span className="min-w-0">
                <span className="block text-[14.5px] font-medium">{w.name}</span>
                <span className="block text-[12.5px] text-muted">{w.phoneMasked} · {w.workload} open jobs</span>
              </span>
            </label>
          ))}
        </div>
        <button type="button" className="self-start text-[13.5px] text-accent" onClick={() => setAll((v) => !v)}>{all ? 'Only matching work' : 'Show all workers'}</button>
        <div>
          <p className="mb-1.5 text-[14px] font-medium">Send the job by</p>
          <Chips label="Send by" value={channel} onChange={setChannel} options={[{ value: 'sms', label: 'SMS' }, { value: 'whatsapp', label: 'WhatsApp' }]} />
          <p className="mt-1.5 text-[13px] text-muted">The job (token, problem, place) is sent to the worker automatically when you assign.</p>
          {noWhatsApp && <p className="mt-1 text-[13px] text-bad">Some selected workers are not on WhatsApp. Use SMS.</p>}
        </div>
        <Button className="self-start" loading={busy} disabled={!picked.length || noWhatsApp}
          onClick={() => run(() => api.assign(ticket, picked, picked[0], channel))}>Assign and send {channel === 'sms' ? 'SMS' : 'WhatsApp'}</Button>
      </Stack>
    </Next>
  )
}

function AssignmentsCard({ ticket, busy, run, canAssign }: { ticket: Ticket; busy: boolean; run: Run; canAssign: boolean }) {
  const [release, setRelease] = useState<string | null>(null)
  const active = ticket.assignments.filter((a) => !a.releasedAt)
  return (
    <Card title="Assigned workers">
      <ul className="divide-y divide-line">
        {active.map((a) => (
          <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
            <span>
              <span className="text-[14.5px] font-medium">{a.workerName}</span> {a.lead && active.length > 1 && <Badge>Lead</Badge>}
              <span className="block text-[13px] text-muted">{a.channel.toUpperCase()} {a.delivery.replace('_', ' ')} · {a.accepted ? `accepted ${ago(a.acceptedAt!)}` : `assigned ${ago(a.assignedAt)}`}</span>
            </span>
            {canAssign && (
              <span className="flex gap-2">
                {!a.accepted && ticket.status === 'Assigned' && (
                  <Button size="sm" variant="secondary" loading={busy} onClick={() => run(() => api.recordAcceptance(ticket, a.id, 'call'))}><Phone size={15} /> Worker confirmed</Button>
                )}
                <Button size="sm" variant="ghost" onClick={() => setRelease(a.id)}>Change worker</Button>
              </span>
            )}
          </li>
        ))}
      </ul>
      {release && (
        <ActionDialog open title="Remove this worker" confirmLabel="Remove" fields={[{ name: 'reason', label: 'Reason', required: true, type: 'textarea' }]}
          onClose={() => setRelease(null)} onSubmit={async (v) => { await run(() => api.releaseAssignment(ticket, release, v.reason)) }} />
      )}
    </Card>
  )
}

// ---------- 3. flag ----------

function FlagStep({ ticket, busy, run, managerName }: { ticket: Ticket; busy: boolean; run: Run; managerName: string }) {
  const [flag, setFlag] = useState<'I' | 'C' | 'P' | null>(ticket.flag === 'I' ? 'I' : null)
  const [note, setNote] = useState('')
  const [cost, setCost] = useState('')
  const [review, setReview] = useState(() => new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10))
  const paise = cost.trim() ? parseRupees(cost) : 0
  const options = [
    { v: 'I' as const, icon: Wrench, title: 'Immediate', body: 'Can be fixed now' },
    { v: 'C' as const, icon: AlertTriangle, title: 'Critical', body: 'Send to institute management' },
    { v: 'P' as const, icon: Clock, title: 'Postpone', body: 'Cannot be done now' },
  ]
  return (
    <Next title="Step 3: What did the worker find?">
      <Stack>
        <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Flag">
          {options.map((o) => (
            <button key={o.v} type="button" role="radio" aria-checked={flag === o.v} onClick={() => setFlag(o.v)}
              className={`flex items-start gap-3 rounded-md border px-3.5 py-3 text-left ${flag === o.v ? 'border-accent bg-accent-soft' : 'border-line hover:bg-subtle'}`}>
              <o.icon size={20} className="mt-0.5 shrink-0" aria-hidden />
              <span><span className="block text-[15px] font-semibold">{o.v} · {o.title}</span><span className="block text-[13px] text-muted">{o.body}</span></span>
            </button>
          ))}
        </div>

        {flag === 'I' && (
          <>
            {ticket.flag !== 'I' && <Button variant="secondary" className="self-start" loading={busy} onClick={() => run(() => api.transition(ticket, { action: 'set_flag', flag: 'I' }))}>Save as Immediate</Button>}
            <Field label="When the work is done: what was done" hint="The reporter is then asked to check it">
              {(id, d) => <Textarea id={id} aria-describedby={d} rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />}
            </Field>
            <Button className="self-start" loading={busy} disabled={!note.trim()} onClick={() => run(() => api.transition(ticket, { action: 'resolve', note: note.trim() }))}>Mark as fixed</Button>
          </>
        )}
        {flag === 'C' && (
          <>
            <Field label="Why is it critical?">{(id) => <Textarea id={id} rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
            <Field label="Estimated cost (Rs)" optional hint="Leave empty if not known yet">
              {(id, d) => <Input id={id} aria-describedby={d} inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} className="sm:w-48" />}
            </Field>
            {paise === null && <p className="text-[13px] text-bad">Enter an amount like 1850 or 1850.50.</p>}
            <Button className="self-start" loading={busy} disabled={!note.trim() || paise === null}
              onClick={() => run(() => api.createProposal(ticket, paise ? [{ label: 'Estimated cost', paise }] : [], new Date().toISOString().slice(0, 10), note.trim()))}>
              Send to management
            </Button>
          </>
        )}
        {flag === 'P' && (
          <>
            <Field label="Why postpone?">{(id) => <Textarea id={id} rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
            <Field label="Look at it again on">{(id) => <Input id={id} type="date" value={review} onChange={(e) => setReview(e.target.value)} className="sm:w-56" />}</Field>
            <Button className="self-start" loading={busy} disabled={!note.trim() || !review}
              onClick={() => run(() => api.transition(ticket, { action: 'hold', reason: note.trim(), owner: managerName, nextAction: 'Review and reassign', reviewDate: review }))}>Postpone</Button>
          </>
        )}
      </Stack>
    </Next>
  )
}

// ---------- 4. management ----------

function ManagementCard({ ticket, busy, run, canDecide }: { ticket: Ticket; busy: boolean; run: Run; canDecide: boolean }) {
  const p = ticket.proposal!
  const [kind, setKind] = useState<DecisionKind>('approved')
  const [ceiling, setCeiling] = useState(p.totalPaise ? String(p.totalPaise / 100) : '')
  const [text, setText] = useState('')
  const [review, setReview] = useState('')
  const ceil = ceiling.trim() ? parseRupees(ceiling) : null
  const ok = kind === 'approved'
    ? (p.totalPaise === 0 ? ceiling.trim() === '' || (ceil !== null && ceil > 0) : ceil !== null && ceil >= p.totalPaise)
    : kind === 'defer' ? !!text.trim() && !!review : !!text.trim()
  return (
    <Card title={`Critical: sent to management${p.totalPaise ? ` · estimate ${formatPaise(p.totalPaise)}` : ''}`}
      className={canDecide ? 'border-accent/40 ring-1 ring-accent/20' : undefined}>
      <p className="flex items-start gap-2 text-[14.5px]"><MessageSquare size={16} className="mt-0.5 shrink-0 text-muted" /> {p.remedy}</p>
      <p className="mt-2 text-[13px] text-muted">Sent by {p.requestedBy}</p>
      {p.state !== 'pending' && p.decidedBy && (
        <div className="mt-3"><Alert tone={p.state === 'approved' ? 'ok' : 'warn'} title={`${p.state === 'approved' ? 'Approved' : p.state === 'rejected' ? 'Rejected' : p.state === 'clarify' ? 'Question asked' : 'Deferred'} by ${p.decidedBy}`}>
          {p.ceilingPaise ? `Up to ${formatPaise(p.ceilingPaise)}. ` : ''}{p.conditions ?? p.reason ?? ''}
        </Alert></div>
      )}
      {canDecide && (
        <Stack className="mt-4">
          <Chips label="Decision" value={kind} onChange={setKind} options={[
            { value: 'approved', label: 'Approve' }, { value: 'clarify', label: 'Ask a question' }, { value: 'defer', label: 'Defer' }, { value: 'rejected', label: 'Reject' }]} />
          {kind === 'approved' && (
            <>
              <Field label="Approved up to (Rs)" optional={p.totalPaise === 0} hint="Work above this needs a new approval">
                {(id, d) => <Input id={id} aria-describedby={d} inputMode="decimal" value={ceiling} onChange={(e) => setCeiling(e.target.value)} className="sm:w-48" />}
              </Field>
              <Field label="Conditions" optional>{(id) => <Input id={id} maxLength={500} value={text} onChange={(e) => setText(e.target.value)} />}</Field>
            </>
          )}
          {kind !== 'approved' && <Field label={kind === 'clarify' ? 'Question for the facility manager' : 'Reason and next step'}>{(id) => <Textarea id={id} rows={2} maxLength={1000} value={text} onChange={(e) => setText(e.target.value)} />}</Field>}
          {kind === 'defer' && <Field label="Review date">{(id) => <Input id={id} type="date" value={review} onChange={(e) => setReview(e.target.value)} className="sm:w-56" />}</Field>}
          <Button className="self-start" loading={busy} disabled={!ok} variant={kind === 'rejected' ? 'danger' : 'primary'}
            onClick={() => run(() => api.decide(p, kind, kind === 'approved'
              ? { ceilingPaise: ceil ?? undefined, conditions: text.trim() || undefined }
              : { reason: text.trim(), reviewDate: kind === 'defer' ? review : undefined }))}>Record decision</Button>
        </Stack>
      )}
    </Card>
  )
}

// ---------- less common actions ----------

function MoreActions({ ticket: t, onPick }: { ticket: Ticket; onPick: (a: Action) => void }) {
  const { can } = useAuth()
  const s = t.status
  const reason = (label = 'Reason'): FormField => ({ name: 'reason', label, type: 'textarea', required: true })
  const list: Action[] = []
  if (can('ticket.triage') && !TERMINAL.includes(s) && s !== 'Submitted') {
    list.push({ key: 'prio', label: 'Change priority', fields: [{ name: 'priority', label: 'New priority', type: 'select', required: true,
      options: (['P1', 'P2', 'P3', 'P4'] as const).filter((x) => x !== t.priority).map((x) => ({ value: x, label: x })) }, reason()],
      build: (v) => ({ action: 'set_priority', priority: v.priority as Priority, reason: v.reason }) })
  }
  if (can('ticket.triage') && ['Submitted', 'Triaged'].includes(s)) {
    list.push({ key: 'dup', label: 'Mark duplicate', fields: [{ name: 'token', label: 'Token of the original ticket', required: true, placeholder: 'C26-0001' }],
      build: (v) => ({ action: 'duplicate', canonicalToken: v.token.toUpperCase() }) })
    list.push({ key: 'cat', label: 'Change type', description: 'The token keeps its original letter.',
      fields: [{ name: 'code', label: 'New type', type: 'select', required: true, options: categories().filter((x) => x.code !== t.categoryCode).map((x) => ({ value: x.code, label: x.nameEn })) }],
      build: (v) => ({ action: 'recategorise', categoryCode: v.code }) })
  }
  if (can('ticket.triage') && ['Triaged', 'Assigned', 'OnHold'].includes(s)) {
    list.push({ key: 'cancel', label: 'Cancel ticket', danger: true, fields: [reason('Reason (the reporter is told)')], build: (v) => ({ action: 'cancel', reason: v.reason }) })
  }
  if (can('ticket.close') && s === 'Resolved') {
    list.push({ key: 'close', label: 'Close without reporter', description: 'Allowed 5 days after it was fixed if the reporter has not answered.',
      fields: [reason()], build: (v) => ({ action: 'close_unverified', reason: v.reason }) })
  }
  if (can('ticket.triage') && ['Resolved', 'Closed'].includes(s)) {
    list.push({ key: 'reopen', label: 'Reopen', fields: [reason()], build: (v) => ({ action: 'reopen', reason: v.reason }) })
  }
  if (!list.length) return null
  return (
    <Card title="More actions">
      <div className="flex flex-wrap gap-2">{list.map((a) => <Button key={a.key} size="sm" variant={a.danger ? 'danger' : 'secondary'} onClick={() => onPick(a)}>{a.label}</Button>)}</div>
    </Card>
  )
}

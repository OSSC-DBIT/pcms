/**
 * Staff ticket page. The highlighted card is always the next step of the flow DBIT confirmed:
 *   1. Review: accept (with priority) or reject with a reason.
 *   2. Contact a worker directly and record the state. PCMS sends no worker messages.
 *   3. After the worker looks at it, choose the flag:
 *        I Immediate  -> fix it now, then mark as fixed
 *        C Critical   -> send to institute management (reason, optional cost)
 *        P Postpone   -> on hold with a reason and review date
 *   4. Management decides critical tickets; the reporter confirms the fix and rates the repair.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import { AlertTriangle, ArrowLeft, Clock, MessageSquare, Wrench } from 'lucide-react'
import { useAuth } from '../../App'
import { ActionDialog, type FormField } from '../../components/ActionDialog'
import { Gallery, Messages, RatingSummary, TicketSummaryCard, Timeline, ago } from '../../components/ticket'
import { Alert, Badge, Button, Card, Chips, Field, Input, Select, Spinner, Stack, Textarea, errorMessage } from '../../components/ui'
import { api, formatPaise, HttpError, parseRupees, type TransitionAction } from '../../lib/api'
import { categories, category } from '../../lib/catalog'
import { TERMINAL, type Assessment, type Channel, type DecisionKind, type Priority, type Ticket } from '../../lib/types'

type Run = (fn: () => Promise<Ticket>) => Promise<boolean>
interface Action { key: string; label: string; danger?: boolean; fields: FormField[]; description?: string; build: (v: Record<string, string>) => TransitionAction }

export default function StaffTicket() {
  const { id } = useParams()
  const { user, can } = useAuth()
  const [ticket, setTicket] = useState<Ticket | null | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [dialog, setDialog] = useState<Action | null>(null)

  const load = useCallback(async () => { if (id) setTicket(await api.getTicket(id)) }, [id])
  useEffect(() => { load().catch(() => setTicket(null)) }, [load])

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
          {can('ticket.assign') && (s === 'Triaged' || s === 'OnHold') && <AssignStep ticket={ticket} busy={busy} run={run} />}
          {can('ticket.assign') && (s === 'Assigned' || s === 'InProgress') && <WorkerLine ticket={ticket} run={run} />}
          {can('ticket.assign') && s === 'Assigned' && <StartStep ticket={ticket} busy={busy} run={run} />}
          {can('ticket.assess') && (s === 'Assigned' || s === 'InProgress') && <AssessStep ticket={ticket} busy={busy} run={run} />}
          {can('ticket.triage') && (s === 'Assigned' || s === 'InProgress') && <FlagStep ticket={ticket} busy={busy} run={run} managerName={user?.name ?? 'Facilities'} />}
          {s === 'AwaitingApproval' && !canDecide && <Alert tone="info" title="Waiting for institute management">Marked critical and sent for a decision.</Alert>}
          {p && <ManagementCard ticket={ticket} busy={busy} run={run} canDecide={!!canDecide} />}
          {s === 'Resolved' && <Alert tone="info" title="Waiting for the reporter to check the work">They can confirm it is fixed or say it is still broken.</Alert>}
          <RatingCard ticket={ticket} />

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

/**
 * The manager contacts the worker outside PCMS, then records the state here.
 * The name is optional and stays internal; no message is sent to the worker.
 */
function AssignStep({ ticket, busy, run }: { ticket: Ticket; busy: boolean; run: Run }) {
  const [name, setName] = useState(ticket.workerName ?? '')
  const onHold = ticket.status === 'OnHold'
  return (
    <Next title={onHold ? 'Step 2: Continue this work' : 'Step 2: Who is doing the work?'}>
      <Stack>
        <Field label="Worker or vendor" optional hint="A person, a vendor or a team. Only staff see this.">
          {(id, d) => <Input id={id} aria-describedby={d} maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />}
        </Field>
        <p className="text-[13px] text-muted">PCMS does not send messages to workers. Contact them by phone, WhatsApp or in person, then record the state here.</p>
        <Button className="self-start" loading={busy}
          onClick={() => run(() => api.transition(ticket, { action: 'assign', workerName: name.trim() || undefined }))}>
          {onHold ? 'Resume work' : 'Mark as assigned'}
        </Button>
      </Stack>
    </Next>
  )
}

function WorkerLine({ ticket, run }: { ticket: Ticket; run: Run }) {
  const [open, setOpen] = useState(false)
  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[14px]">
          <span className="text-muted">Worker: </span>
          {ticket.workerName ? <span className="font-medium">{ticket.workerName}</span> : <span className="text-muted">No worker recorded</span>}
        </p>
        <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>{ticket.workerName ? 'Change' : 'Add worker name'}</Button>
      </div>
      {open && (
        <ActionDialog open title="Worker or vendor" confirmLabel="Save"
          description="Only staff see this. Leave the field blank to clear the name."
          initial={{ workerName: ticket.workerName ?? '' }}
          fields={[{ name: 'workerName', label: 'Name', placeholder: 'For example, Ramesh K or Carpentry vendor' }]}
          onClose={() => setOpen(false)}
          onSubmit={async (v) => { await run(() => api.transition(ticket, { action: 'set_worker', workerName: v.workerName || undefined })) }} />
      )}
    </Card>
  )
}

function StartStep({ ticket, busy, run }: { ticket: Ticket; busy: boolean; run: Run }) {
  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[14px] text-muted">Has the worker started? This is optional; you can mark the work fixed from here.</p>
        <Button size="sm" variant="secondary" loading={busy} onClick={() => run(() => api.transition(ticket, { action: 'start' }))}>Mark work started</Button>
      </div>
    </Card>
  )
}

// ---------- 3. assess ----------

const ASSESSMENT_LABEL: Record<Assessment, string> = {
  simple: 'One person can do it',
  workforce: 'Needs more people',
  parts: 'Needs parts',
  expenditure: 'Needs money up front',
}

const ASSESS_VIA = [
  { value: 'in_person' as const, label: 'In person' },
  { value: 'call' as const, label: 'Phone call' },
  { value: 'sms' as const, label: 'SMS' },
  { value: 'whatsapp' as const, label: 'WhatsApp' },
  { value: 'card' as const, label: 'Job card' },
]

/**
 * What the worker found, recorded before the I/C/P flag. Optional in the flow,
 * but it is what tells management whether a ticket needs money or people.
 */
function AssessStep({ ticket, busy, run }: { ticket: Ticket; busy: boolean; run: Run }) {
  const [picked, setPicked] = useState<Assessment[]>(ticket.assessments)
  const [via, setVia] = useState<Channel | 'in_person'>('in_person')
  const [note, setNote] = useState('')
  const [open, setOpen] = useState(false)
  const recorded = ticket.assessments.length > 0

  if (!recorded && !open) {
    return (
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-[14px] text-muted">Recorded what the work needs? It helps management decide.</p>
          <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>Record assessment</Button>
        </div>
      </Card>
    )
  }

  return (
    <Card title="Assessment" subtitle={recorded ? 'What the work needs' : undefined}>
      <Stack>
        {recorded && !open && (
          <p className="text-[14px]">
            {ticket.assessments.map((a) => ASSESSMENT_LABEL[a]).join(', ')}
            <Button size="sm" variant="ghost" className="ml-2" onClick={() => setOpen(true)}>Change</Button>
          </p>
        )}
        {open && (
          <form onSubmit={(e) => { e.preventDefault(); void run(() => api.recordAssessment(ticket, picked, via, note.trim())).then((ok) => { if (ok) { setOpen(false); setNote('') } }) }} className="space-y-4">
            <div className="grid gap-2 sm:grid-cols-2">
              {(Object.keys(ASSESSMENT_LABEL) as Assessment[]).map((a) => (
                <label key={a} className={`flex cursor-pointer items-center gap-3 rounded-md border px-3.5 py-2.5 ${picked.includes(a) ? 'border-accent bg-accent-soft' : 'border-line'}`}>
                  <input type="checkbox" className="h-4 w-4 accent-[var(--c-accent)]" checked={picked.includes(a)}
                    onChange={() => setPicked((x) => x.includes(a) ? x.filter((y) => y !== a) : [...x, a])} />
                  <span className="text-[14.5px]">{ASSESSMENT_LABEL[a]}</span>
                </label>
              ))}
            </div>
            <Field label="How it was reported">
              {(id) => <Select id={id} value={via} onChange={(e) => setVia(e.target.value as Channel | 'in_person')}>
                {ASSESS_VIA.map((v) => <option key={v.value} value={v.value}>{v.label}</option>)}
              </Select>}
            </Field>
            <Field label="What was found" hint="Internal note. The reporter does not see this.">
              {(id, d) => <Textarea id={id} aria-describedby={d} rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} required />}
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" loading={busy} disabled={!picked.length || note.trim().length < 2}>Save assessment</Button>
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            </div>
          </form>
        )}
      </Stack>
    </Card>
  )
}

// ---------- 4. flag ----------

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

/** Read-only view of the reporter rating. Staff cannot edit or delete it. */
function RatingCard({ ticket }: { ticket: Ticket }) {
  if (ticket.rating) {
    return (
      <Card title="Reporter rating" subtitle="Given after the repair was closed">
        <RatingSummary stars={ticket.rating.stars} comment={ticket.rating.comment} createdAt={ticket.rating.createdAt} />
      </Card>
    )
  }
  if (ticket.status !== 'Closed') return null
  return <Card title="Reporter rating"><p className="text-[14px] text-muted">Not rated yet.</p></Card>
}

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

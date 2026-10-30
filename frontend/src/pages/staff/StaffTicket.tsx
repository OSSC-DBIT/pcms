/**
 * Staff ticket page. The highlighted card is always the next step of the flow DBIT confirmed:
 *   1. Review: accept (with priority) or reject with a reason.
 *   2. Contact a worker directly and record the state. PCMS sends no worker messages.
 *   3. After the worker looks at it, choose the next step:
 *        Immediate  -> fix it now, then mark as fixed
 *        Critical   -> send to institute management (reason, optional cost)
 *        Postpone   -> on hold with a reason and review date
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
import { categories, category, categoryName } from '../../lib/catalog'
import { useT } from '../../lib/i18n'
import { TERMINAL, type Assessment, type Channel, type DecisionKind, type Priority, type Ticket } from '../../lib/types'

type Run = (fn: () => Promise<Ticket>) => Promise<boolean>
interface Action { key: string; label: string; danger?: boolean; fields: FormField[]; description?: string; build: (v: Record<string, string>) => TransitionAction }

export default function StaffTicket() {
  const { id } = useParams()
  const { user, can } = useAuth()
  const { t, lang } = useT()
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
      if (e instanceof HttpError && e.code === 'stale_version') { setError(t('ticket.stale')); await load() }
      else setError(errorMessage(e))
      return false
    } finally { setBusy(false) }
  }, [load, t])

  if (ticket === undefined) return <Spinner />
  if (ticket === null) return <p className="text-muted">{t('ticket.notFound')}</p>

  const s = ticket.status
  const p = ticket.proposal
  const approvedCritical = ticket.flag === 'C' && p?.state === 'approved'
  const canDecide = can('cost.approve') && p?.state === 'pending' && p.requestedById !== user?.id && ticket.reporterId !== user?.id

  return (
    <Stack>
      <Link to="/staff" className="inline-flex items-center gap-1 text-[14px] text-accent"><ArrowLeft size={16} /> {t('queue.title')}</Link>
      <div className="grid gap-4 lg:grid-cols-[1fr_380px]">
        <Stack>
          <TicketSummaryCard ticket={ticket}>
            <div className="mt-3 flex flex-wrap gap-2">
              <Badge>{t('ticket.priority', { priority: ticket.priority })}</Badge>
              {approvedCritical && <Badge tone="ok">{t('ticket.spendingApproved')}</Badge>}
              {ticket.originalCategoryCode !== ticket.categoryCode && <Badge>{t('ticket.reportedAs', { name: categoryName(category(ticket.originalCategoryCode), lang) })}</Badge>}
              <Badge>{t('ticket.age', { age: ago(ticket.createdAt, t, lang) })}</Badge>
            </div>
            {(ticket.accessNote || ticket.altContact) && (
              <p className="mt-3 text-[14px]">{ticket.accessNote && <>{t('ticket.access', { note: ticket.accessNote })} </>}{ticket.altContact && <>{t('ticket.contact', { contact: ticket.altContact })}</>}</p>
            )}
            {s === 'OnHold' && ticket.holdReason && <div className="mt-3"><Alert tone="warn" title={t('ticket.postponed')}>{ticket.holdReason}{ticket.holdReviewDate && ` · ${t('ticket.review', { date: ticket.holdReviewDate })}`}</Alert></div>}
          </TicketSummaryCard>

          {error && <Alert tone="bad">{error}</Alert>}

          {can('ticket.triage') && s === 'Submitted' && <ReviewStep ticket={ticket} busy={busy} run={run} />}
          {can('ticket.assign') && (s === 'Triaged' || s === 'OnHold') && <AssignStep ticket={ticket} busy={busy} run={run} />}
          {can('ticket.assign') && s === 'Assigned' && <StartStep ticket={ticket} busy={busy} run={run} />}
          {can('ticket.assess') && (s === 'Assigned' || s === 'InProgress') && <AssessStep ticket={ticket} busy={busy} run={run} />}
          {can('ticket.triage') && (s === 'Assigned' || s === 'InProgress') && <FlagStep key={ticket.id} ticket={ticket} busy={busy} run={run} managerName={user?.name ?? 'Facilities'} approved={approvedCritical} />}
          {s === 'AwaitingApproval' && !canDecide && <Alert tone="info" title={t('ticket.managementWaiting')}>{t('ticket.managementWaitingBody')}</Alert>}
          {p && <ManagementCard ticket={ticket} busy={busy} run={run} canDecide={!!canDecide} />}
          {s === 'Resolved' && <Alert tone="info" title={t('ticket.reporterCheck')}>{t('ticket.reporterCheckBody')}</Alert>}
          <RatingCard ticket={ticket} />

          <Card title={t('ticket.photosVideo')}><Gallery ticket={ticket} canAdd={!TERMINAL.includes(s)} onChanged={load} /></Card>
        </Stack>

        <Stack>
          <MoreActions ticket={ticket} onPick={setDialog} />
          <Card title={t('ticket.messagesNotes')}>
            <Messages staff comments={ticket.comments} onSend={async (body, internal) => { setTicket(await api.addComment(ticket, body, internal)) }} />
          </Card>
          <Card title={t('ticket.history')}><Timeline events={ticket.events} /></Card>
        </Stack>
      </div>

      {dialog && (
        <ActionDialog open title={dialog.label} description={dialog.description} fields={dialog.fields} confirmLabel={dialog.label} danger={dialog.danger}
          onClose={() => setDialog(null)} onSubmit={async (v) => setTicket(await api.transition(ticket, dialog.build(v)))} />
      )}
    </Stack>
  )
}

function Next({ title, children }: { title: string; children: ReactNode }) {
  return <Card title={title} className="border-accent/40 ring-1 ring-accent/20">{children}</Card>
}

// ---------- 1. review ----------

function ReviewStep({ ticket, busy, run }: { ticket: Ticket; busy: boolean; run: Run }) {
  const { t } = useT()
  const [priority, setPriority] = useState<Priority>(ticket.priority)
  const [rejecting, setRejecting] = useState(false)
  const [reason, setReason] = useState('')
  return (
    <Next title={t('ticket.step1')}>
      <Stack>
        <div>
          <p className="mb-1.5 text-[14px] font-medium">{t('ticket.priorityLabel')}</p>
          <Chips label={t('ticket.priorityLabel')} value={priority} onChange={setPriority} options={[
            { value: 'P1', label: t('priority.P1') }, { value: 'P2', label: t('priority.P2') }, { value: 'P3', label: t('priority.P3') }, { value: 'P4', label: t('priority.P4') }]} />
        </div>
        {!rejecting ? (
          <div className="flex flex-wrap gap-2">
            <Button loading={busy} onClick={() => run(() => api.transition(ticket, { action: 'triage', priority }))}>{t('action.accept')}</Button>
            <Button variant="danger" onClick={() => setRejecting(true)}>{t('action.reject')}</Button>
          </div>
        ) : (
          <Stack>
            <Field label={t('ticket.rejectReason')} hint={t('ticket.rejectReasonHint')}>
              {(id, d) => <Textarea id={id} aria-describedby={d} rows={2} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />}
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button variant="danger" loading={busy} disabled={!reason.trim()} onClick={() => run(() => api.transition(ticket, { action: 'reject', reason: reason.trim() }))}>{t('ticket.rejectReport')}</Button>
              <Button variant="ghost" onClick={() => setRejecting(false)}>{t('action.back')}</Button>
            </div>
          </Stack>
        )}
      </Stack>
    </Next>
  )
}

// ---------- 2. assign ----------

/** The manager contacts the worker outside PCMS, then records the state here. */
function AssignStep({ ticket, busy, run }: { ticket: Ticket; busy: boolean; run: Run }) {
  const { t } = useT()
  const onHold = ticket.status === 'OnHold'
  return (
    <Next title={onHold ? t('ticket.step2Continue') : t('ticket.step2')}>
      <Stack>
        <p className="text-[13px] text-muted">{t('ticket.workerNoMessages')}</p>
        <Button className="self-start" loading={busy}
          onClick={() => run(() => api.transition(ticket, { action: 'assign' }))}>
          {onHold ? t('ticket.resumeWork') : t('ticket.markAssigned')}
        </Button>
      </Stack>
    </Next>
  )
}

function StartStep({ ticket, busy, run }: { ticket: Ticket; busy: boolean; run: Run }) {
  const { t } = useT()
  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[14px] text-muted">{t('ticket.workStarted')}</p>
        <Button size="sm" variant="secondary" loading={busy} onClick={() => run(() => api.transition(ticket, { action: 'start' }))}>{t('ticket.markWorkStarted')}</Button>
      </div>
    </Card>
  )
}

// ---------- 3. assess ----------

const ASSESSMENTS: Assessment[] = ['simple', 'workforce', 'parts', 'expenditure']

/**
 * What the worker found, recorded before the next step is chosen. Optional in the flow,
 * but it is what tells management whether a ticket needs money or people.
 */
function AssessStep({ ticket, busy, run }: { ticket: Ticket; busy: boolean; run: Run }) {
  const { t } = useT()
  const viaOptions = [
    { value: 'in_person' as const, label: t('channel.in_person') },
    { value: 'call' as const, label: t('channel.call') },
    { value: 'sms' as const, label: t('channel.sms') },
    { value: 'whatsapp' as const, label: t('channel.whatsapp') },
    { value: 'card' as const, label: t('channel.card') },
  ]
  const [picked, setPicked] = useState<Assessment[]>(ticket.assessments)
  const [via, setVia] = useState<Channel | 'in_person'>('in_person')
  const [note, setNote] = useState('')
  const [open, setOpen] = useState(false)
  const recorded = ticket.assessments.length > 0

  if (!recorded && !open) {
    return (
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-[14px] text-muted">{t('ticket.assessmentRecorded')}</p>
          <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>{t('ticket.recordAssessment')}</Button>
        </div>
      </Card>
    )
  }

  return (
    <Card title={t('ticket.assessmentSubtitle')} subtitle={recorded ? t('ticket.assessmentSubtitle') : undefined}>
      <Stack>
        {recorded && !open && (
          <p className="text-[14px]">
            {ticket.assessments.map((a) => t(`assessment.${a}`)).join(', ')}
            <Button size="sm" variant="ghost" className="ml-2" onClick={() => setOpen(true)}>{t('ticket.change')}</Button>
          </p>
        )}
        {open && (
          <form onSubmit={(e) => { e.preventDefault(); void run(() => api.recordAssessment(ticket, picked, via, note.trim())).then((ok) => { if (ok) { setOpen(false); setNote('') } }) }} className="space-y-4">
            <div className="grid gap-2 sm:grid-cols-2">
              {ASSESSMENTS.map((a) => (
                <label key={a} className={`flex cursor-pointer items-center gap-3 rounded-md border px-3.5 py-2.5 ${picked.includes(a) ? 'border-accent bg-accent-soft' : 'border-line'}`}>
                  <input type="checkbox" className="h-4 w-4 accent-[var(--c-accent)]" checked={picked.includes(a)}
                    onChange={() => setPicked((x) => x.includes(a) ? x.filter((y) => y !== a) : [...x, a])} />
                  <span className="text-[14.5px]">{t(`assessment.${a}`)}</span>
                </label>
              ))}
            </div>
            <Field label={t('ticket.howReported')}>
              {(id) => <Select id={id} value={via} onChange={(e) => setVia(e.target.value as Channel | 'in_person')}>
                {viaOptions.map((v) => <option key={v.value} value={v.value}>{v.label}</option>)}
              </Select>}
            </Field>
            <Field label={t('ticket.whatFound')} hint={t('ticket.internalNoteHint')}>
              {(id, d) => <Textarea id={id} aria-describedby={d} rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} required />}
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" loading={busy} disabled={!picked.length || note.trim().length < 2}>{t('ticket.saveAssessment')}</Button>
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>{t('action.cancel')}</Button>
            </div>
          </form>
        )}
      </Stack>
    </Card>
  )
}

// ---------- 4. next step ----------

function FlagStep({ ticket, busy, run, managerName, approved = false }: { ticket: Ticket; busy: boolean; run: Run; managerName: string; approved?: boolean }) {
  const { t } = useT()
  const [flag, setFlag] = useState<'I' | 'C' | 'P' | null>(approved || ticket.flag === 'I' ? 'I' : null)
  const [note, setNote] = useState('')
  const [cost, setCost] = useState('')
  const [review, setReview] = useState(() => new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10))
  const paise = cost.trim() ? parseRupees(cost) : 0
  const options = [
    { v: 'I' as const, icon: Wrench, title: t('ticket.immediate'), body: approved ? t('ticket.immediateApproved') : t('ticket.immediateBody') },
    { v: 'C' as const, icon: AlertTriangle, title: t('ticket.critical'), body: approved ? t('ticket.criticalApproved') : t('ticket.criticalBody') },
    { v: 'P' as const, icon: Clock, title: t('ticket.postpone'), body: t('ticket.postponeBody') },
  ]
  return (
    <Next title={approved ? t('ticket.step4') : t('ticket.step3')}>
      <Stack>
        {approved && (
          <Alert tone="ok" title={t('ticket.approvedByManagement')}>
            {t('ticket.approvedHelp')}
          </Alert>
        )}
        <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label={t('ticket.nextStep')}>
          {options.map((o) => (
            <button key={o.v} type="button" role="radio" aria-checked={flag === o.v} onClick={() => setFlag(o.v)}
              className={`flex items-start gap-3 rounded-md border px-3.5 py-3 text-left ${flag === o.v ? 'border-accent bg-accent-soft' : 'border-line hover:bg-subtle'}`}>
              <o.icon size={20} className="mt-0.5 shrink-0" aria-hidden />
              <span><span className="block text-[15px] font-semibold">{o.title}</span><span className="block text-[13px] text-muted">{o.body}</span></span>
            </button>
          ))}
        </div>

        {flag === 'I' && (
          <>
            {!approved && ticket.flag !== 'I' && <Button variant="secondary" className="self-start" loading={busy} onClick={() => run(() => api.transition(ticket, { action: 'set_flag', flag: 'I' }))}>{t('ticket.saveImmediate')}</Button>}
            <Field label={t('ticket.whatDone')} hint={t('ticket.whatDoneHint')}>
              {(id, d) => <Textarea id={id} aria-describedby={d} rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />}
            </Field>
            <Button className="self-start" loading={busy} disabled={!note.trim()} onClick={() => run(() => api.transition(ticket, { action: 'resolve', note: note.trim() }))}>{t('ticket.markFixed')}</Button>
          </>
        )}
        {flag === 'C' && (
          <>
            <Field label={t('ticket.whyCritical')}>{(id) => <Textarea id={id} rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
            <Field label={t('ticket.estimatedCost')} optional hint={t('ticket.estimatedCostHint')}>
              {(id, d) => <Input id={id} aria-describedby={d} inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} className="sm:w-48" />}
            </Field>
            {paise === null && <p className="text-[13px] text-bad">{t('ticket.costFormat')}</p>}
            <Button className="self-start" loading={busy} disabled={!note.trim() || paise === null}
              onClick={() => run(() => api.createProposal(ticket, paise ? [{ label: t('ticket.estimatedCost'), paise }] : [], new Date().toISOString().slice(0, 10), note.trim()))}>
              {t('ticket.sendManagement')}
            </Button>
          </>
        )}
        {flag === 'P' && (
          <>
            <Field label={t('ticket.whyPostpone')}>{(id) => <Textarea id={id} rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
            <Field label={t('ticket.reviewOn')}>{(id) => <Input id={id} type="date" value={review} onChange={(e) => setReview(e.target.value)} className="sm:w-56" />}</Field>
            <Button className="self-start" loading={busy} disabled={!note.trim() || !review}
              onClick={() => run(() => api.transition(ticket, { action: 'hold', reason: note.trim(), owner: managerName, nextAction: t('ticket.reviewReassign'), reviewDate: review }))}>{t('ticket.postpone')}</Button>
          </>
        )}
      </Stack>
    </Next>
  )
}

// ---------- 4. management ----------

/** Read-only view of the reporter rating. Staff cannot edit or delete it. */
function RatingCard({ ticket }: { ticket: Ticket }) {
  const { t } = useT()
  if (ticket.rating) {
    return (
      <Card title={t('ticket.reporterRating')} subtitle={t('ticket.ratingGiven')}>
        <RatingSummary stars={ticket.rating.stars} comment={ticket.rating.comment} createdAt={ticket.rating.createdAt} />
      </Card>
    )
  }
  if (ticket.status !== 'Closed') return null
  return <Card title={t('ticket.reporterRating')}><p className="text-[14px] text-muted">{t('ticket.notRated')}</p></Card>
}

function ManagementCard({ ticket, busy, run, canDecide }: { ticket: Ticket; busy: boolean; run: Run; canDecide: boolean }) {
  const { t } = useT()
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
    <Card title={`${t('ticket.criticalSent')}${p.totalPaise ? ` · ${t('ticket.estimate', { amount: formatPaise(p.totalPaise) })}` : ''}`}
      className={canDecide ? 'border-accent/40 ring-1 ring-accent/20' : undefined}>
      <p className="flex items-start gap-2 text-[14.5px]"><MessageSquare size={16} className="mt-0.5 shrink-0 text-muted" /> {p.remedy}</p>
      <p className="mt-2 text-[13px] text-muted">{t('ticket.sentBy', { name: p.requestedBy })}</p>
      {p.state !== 'pending' && p.decidedBy && (
        <div className="mt-3"><Alert tone={p.state === 'approved' ? 'ok' : 'warn'} title={t('ticket.decidedBy', { decision: t(`decisionState.${p.state}`), name: p.decidedBy })}>
          {p.ceilingPaise ? t('ticket.upTo', { amount: formatPaise(p.ceilingPaise) }) : ''}{p.conditions ?? p.reason ?? ''}
        </Alert></div>
      )}
      {canDecide && (
        <Stack className="mt-4">
          <Chips label={t('ticket.decision')} value={kind} onChange={setKind} options={[
            { value: 'approved', label: t('decision.approved') }, { value: 'clarify', label: t('decision.clarify') }, { value: 'defer', label: t('decision.defer') }, { value: 'rejected', label: t('decision.rejected') }]} />
          {kind === 'approved' && (
            <>
              <Field label={t('ticket.approvedUpTo')} optional={p.totalPaise === 0} hint={t('ticket.approvedUpToHint')}>
                {(id, d) => <Input id={id} aria-describedby={d} inputMode="decimal" value={ceiling} onChange={(e) => setCeiling(e.target.value)} className="sm:w-48" />}
              </Field>
              <Field label={t('ticket.conditions')} optional>{(id) => <Input id={id} maxLength={500} value={text} onChange={(e) => setText(e.target.value)} />}</Field>
            </>
          )}
          {kind !== 'approved' && <Field label={kind === 'clarify' ? t('ticket.questionForManager') : t('ticket.reasonNextStep')}>{(id) => <Textarea id={id} rows={2} maxLength={1000} value={text} onChange={(e) => setText(e.target.value)} />}</Field>}
          {kind === 'defer' && <Field label={t('ticket.reviewDate')}>{(id) => <Input id={id} type="date" value={review} onChange={(e) => setReview(e.target.value)} className="sm:w-56" />}</Field>}
          <Button className="self-start" loading={busy} disabled={!ok} variant={kind === 'rejected' ? 'danger' : 'primary'}
            onClick={() => run(() => api.decide(p, kind, kind === 'approved'
              ? { ceilingPaise: ceil ?? undefined, conditions: text.trim() || undefined }
              : { reason: text.trim(), reviewDate: kind === 'defer' ? review : undefined }))}>{t('ticket.recordDecision')}</Button>
        </Stack>
      )}
    </Card>
  )
}

// ---------- less common actions ----------

function MoreActions({ ticket, onPick }: { ticket: Ticket; onPick: (a: Action) => void }) {
  const { can } = useAuth()
  const { t, lang } = useT()
  const s = ticket.status
  const reason = (label = t('action.reason')): FormField => ({ name: 'reason', label, type: 'textarea', required: true })
  const list: Action[] = []
  if (can('ticket.triage') && !TERMINAL.includes(s) && s !== 'Submitted') {
    list.push({ key: 'prio', label: t('ticket.changePriority'), fields: [{ name: 'priority', label: t('ticket.newPriority'), type: 'select', required: true,
      options: (['P1', 'P2', 'P3', 'P4'] as const).filter((x) => x !== ticket.priority).map((x) => ({ value: x, label: x })) }, reason()],
      build: (v) => ({ action: 'set_priority', priority: v.priority as Priority, reason: v.reason }) })
  }
  if (can('ticket.triage') && ['Submitted', 'Triaged'].includes(s)) {
    list.push({ key: 'dup', label: t('ticket.markDuplicate'), fields: [{ name: 'token', label: t('ticket.originalToken'), required: true, placeholder: 'C26-0001' }],
      build: (v) => ({ action: 'duplicate', canonicalToken: v.token.toUpperCase() }) })
    list.push({ key: 'cat', label: t('ticket.changeType'), description: t('ticket.changeTypeDesc'),
      fields: [{ name: 'code', label: t('ticket.newType'), type: 'select', required: true, options: categories().filter((x) => x.code !== ticket.categoryCode).map((x) => ({ value: x.code, label: categoryName(x, lang) })) }],
      build: (v) => ({ action: 'recategorise', categoryCode: v.code }) })
  }
  if (can('ticket.triage') && ['Triaged', 'Assigned', 'OnHold'].includes(s)) {
    list.push({ key: 'cancel', label: t('ticket.cancelTicket'), danger: true, fields: [reason(t('ticket.reasonReporter'))], build: (v) => ({ action: 'cancel', reason: v.reason }) })
  }
  if (can('ticket.close') && s === 'Resolved') {
    list.push({ key: 'close', label: t('ticket.closeWithoutReporter'), description: t('ticket.closeWithoutReporterDesc'),
      fields: [reason()], build: (v) => ({ action: 'close_unverified', reason: v.reason }) })
  }
  if (can('ticket.triage') && ['Resolved', 'Closed'].includes(s)) {
    list.push({ key: 'reopen', label: t('ticket.reopen'), fields: [reason()], build: (v) => ({ action: 'reopen', reason: v.reason }) })
  }
  if (!list.length) return null
  return (
    <Card title={t('ticket.moreActions')}>
      <div className="flex flex-wrap gap-2">{list.map((a) => <Button key={a.key} size="sm" variant={a.danger ? 'danger' : 'secondary'} onClick={() => onPick(a)}>{a.label}</Button>)}</div>
    </Card>
  )
}

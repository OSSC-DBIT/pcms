import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { motion } from 'framer-motion'
import { api, category, formatPaise, localName } from '../../lib/api'
import { useAuth } from '../../App'
import { useT } from '../../lib/i18n'
import { useSwipeBack } from '../../lib/hooks'
import { Button, Card, CheckChip, Field, NavBar, SectionLabel, Segmented, Skeleton, TextInput, spring } from '../../components/ui'
import { TokenHero } from '../faculty/Receipt'
import { locationLine } from '../../components/TicketRow'
import type { Assessment, DecisionKind, Priority, Ticket, WorkFlag, Worker } from '../../lib/types'

export default function AdminTicket() {
  const { id } = useParams()
  const { user } = useAuth()
  const { lang } = useT()
  const swipe = useSwipeBack()
  const [ticket, setTicket] = useState<Ticket | null | undefined>(undefined)
  const [workers, setWorkers] = useState<Worker[]>([])

  useEffect(() => {
    let live = true
    if (id) api.getTicket(id).then((tk) => live && setTicket(tk))
    api.listWorkers().then((ws) => live && setWorkers(ws))
    return () => { live = false }
  }, [id])

  if (ticket === undefined) return <div><NavBar title="Admin" /><div className="space-y-3 px-4 pt-6"><Skeleton className="h-36" /><Skeleton className="h-48" /></div></div>
  if (ticket === null) return <div><NavBar title="Admin" /><p className="px-4 pt-8 text-[15px] text-muted">Ticket not found.</p></div>

  const canTriage = user?.capabilities.includes('ticket.triage')
  const canAssign = user?.capabilities.includes('ticket.assign')
  const canApprove = user?.capabilities.includes('cost.approve') && ticket.reporterId !== user?.id
  const set = (tk: Ticket) => setTicket(tk)
  const cat = category(ticket.categoryCode)

  return (
    <div {...swipe} className="mx-auto min-h-dvh max-w-lg pb-24">
      <NavBar title={<span className="token text-[14px]">{ticket.token}</span>} />
      <TokenHero ticket={ticket} />
      <div className="px-4 pt-6">
        <h2 className="balance text-[19px] font-bold tracking-[-0.02em]">{ticket.title}</h2>
        <p className="mt-1 text-[13px] text-muted">{locationLine(ticket, lang)} · {localName(cat, lang)}{ticket.subtype ? ` · ${ticket.subtype}` : ''}</p>
        <p className="pretty mt-3 max-w-[62ch] text-[14.5px] leading-6">{ticket.description}</p>
        <p className="token mt-3 text-[12px] text-muted">{ticket.reporterName} · age {relAge(ticket.createdAt)}</p>
      </div>

      {canTriage && ticket.status === 'Submitted' && <TriageBox ticket={ticket} onDone={set} actor={user!.name} />}
      {canAssign && ['Triaged', 'OnHold'].includes(ticket.status) && <DispatchBox ticket={ticket} workers={workers} onDone={set} actor={user!.name} />}
      {canAssign && ticket.assignments.length > 0 && (
        <>
          <SectionLabel>Assignments</SectionLabel>
          <Card className="inset-hr mx-4">
            {ticket.assignments.map((a) => (
              <div key={a.id} className="flex min-h-[56px] items-center justify-between gap-3 px-4 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-[14.5px] font-medium">{a.workerName}{a.lead && <span className="token ml-2 text-[10.5px] font-bold text-muted">LEAD</span>}</p>
                  <p className="token mt-0.5 text-[12px] text-muted">{a.channel} · {a.accepted ? `accepted ${relAge(a.acceptedAt!)}` : `sent ${relAge(a.assignedAt)} — not accepted`}</p>
                </div>
                {a.accepted
                  ? <span className="rounded-full border border-line px-2.5 py-0.5 text-[11.5px] font-semibold text-muted">accepted</span>
                  : canAssign && <Button variant="secondary" className="h-9 w-auto max-w-none flex-none px-3.5 text-[13px]" onClick={async () => set(await api.acceptAssignment(ticket.id, a.id, a.workerName))}>Record accept</Button>}
              </div>
            ))}
          </Card>
        </>
      )}
      {canAssign && ticket.status === 'InProgress' && <AssessBox ticket={ticket} onDone={set} actor={user!.name} />}
      {canApprove && ticket.status === 'AwaitingApproval' && ticket.proposal && <DecisionBox ticket={ticket} onDone={set} actor={user!.name} />}
      {canTriage && ticket.status === 'InProgress' && (
        <div className="px-4 pt-6">
          <Button onClick={async () => set(await api.resolve(ticket.id, user!.name, 'Completion recorded with evidence'))}>Mark resolved — awaiting faculty verification</Button>
        </div>
      )}
      {canAssign && ['Submitted', 'Triaged'].includes(ticket.status) && (
        <div className="px-4 pt-5">
          <div className="flex gap-3">
            <MarkDuplicate ticket={ticket} onDone={set} actor={user!.name} />
            <Recategorise ticket={ticket} onDone={set} lang={lang} />
          </div>
        </div>
      )}

      <CommentsBox ticket={ticket} onDone={set} actor={user!.name} />

      <SectionLabel>Audit timeline</SectionLabel>
      <Card className="mx-4 px-4 py-2">
        <ol className="relative ml-2 border-l border-line">
          {ticket.events.map((e, i) => (
            <motion.li key={e.id} initial={i === ticket.events.length - 1 ? { opacity: 0, y: 6 } : false} animate={{ opacity: 1, y: 0 }} transition={spring} className="relative pb-4.5 pl-5 last:pb-1">
              <span className="absolute -left-[4.5px] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-fg bg-surface" />
              <p className="text-[13.5px] font-semibold">{e.action}</p>
              <p className="mt-0.5 text-[12px] text-muted">{new Date(e.at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })} · {e.actor}{e.detail ? ` · ${e.detail}` : ''}</p>
            </motion.li>
          ))}
        </ol>
      </Card>
    </div>
  )
}

function relAge(iso: string): string {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.round(h / 24)}d`
}

function Box({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <motion.section initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={spring} className="mx-4 mt-6 rounded-[14px] border border-line bg-surface p-4 shadow-[0_1px_2px_rgba(0,0,0,0.05)]">
      <p className="mb-3 text-[12.5px] font-semibold uppercase tracking-[0.04em] text-muted">{title}</p>
      {children}
    </motion.section>
  )
}

function TriageBox({ ticket, onDone, actor }: { ticket: Ticket; onDone: (t: Ticket) => void; actor: string }) {
  const [priority, setPriority] = useState<Priority>('P3')
  const [flag, setFlag] = useState<WorkFlag>('I')
  return (
    <Box title="Triage — urgency and work type are separate">
      <p className="mb-1.5 text-[12.5px] font-medium text-muted">Priority</p>
      <Segmented label="prio" value={priority} onChange={setPriority} options={['P1', 'P2', 'P3', 'P4'].map((p) => ({ value: p as Priority, label: p }))} />
      <p className="mb-1.5 mt-4 text-[12.5px] font-medium text-muted">Flag — I immediate · C complex · P postponed</p>
      <Segmented label="flag" value={flag} onChange={setFlag} options={[
        { value: 'I', label: 'I · now' }, { value: 'C', label: 'C · more' }, { value: 'P', label: 'P · later' },
      ]} />
      <Button className="mt-4" onClick={async () => onDone(await api.triage(ticket.id, priority, flag, actor))}>Confirm triage</Button>
    </Box>
  )
}

function DispatchBox({ ticket, workers, onDone, actor }: { ticket: Ticket; workers: Worker[]; onDone: (t: Ticket) => void; actor: string }) {
  const eligible = useMemo(() => workers.filter((w) => w.trades.includes(ticket.categoryCode)), [workers, ticket.categoryCode])
  const [picked, setPicked] = useState<string[]>([])
  const [lead, setLead] = useState('')
  const [channel, setChannel] = useState<'whatsapp' | 'sms' | 'call' | 'card'>('whatsapp')
  const chosen = workers.filter((w) => picked.includes(w.id))
  return (
    <Box title="Dispatch workers">
      {eligible.length === 0 && <p className="mb-3 text-[13px] leading-5 text-muted">No active worker with this trade. Add them to the directory or recategorise.</p>}
      <div className="inset-hr rounded-[12px] border border-line">
        {eligible.map((w) => (
          <button key={w.id} onClick={() => setPicked((p) => p.includes(w.id) ? p.filter((x) => x !== w.id) : [...p, w.id])} disabled={!w.active}
            className={`flex w-full items-center justify-between gap-3 px-3.5 py-3 text-left transition-colors ${picked.includes(w.id) ? 'bg-fg/5' : ''} ${!w.active ? 'opacity-40' : ''}`}>
            <span className="min-w-0">
              <span className="block truncate text-[14.5px] font-medium">{w.name}</span>
              <span className="token block text-[12px] text-muted">{w.phoneMasked} · {w.mode} · {w.language.toUpperCase()} · {w.kind === 'vendor' ? 'VENDOR' : 'EMPLOYEE'}</span>
            </span>
            <span className="flex shrink-0 items-center gap-2 text-right">
              <span className="token text-[12.5px] text-muted">{w.workload} jobs</span>
              <span className={`h-2.5 w-2.5 rounded-full ${picked.includes(w.id) ? 'bg-inverse' : 'border border-line'}`} />
            </span>
          </button>
        ))}
      </div>
      {chosen.length > 1 && (
        <div className="mt-3">
          <p className="mb-1.5 text-[12.5px] font-medium text-muted">Lead — one worker accountable</p>
          <Segmented label="lead" value={lead || chosen[0].id} onChange={setLead} options={chosen.map((w) => ({ value: w.id, label: w.name.split('—')[0].trim().split(' ')[0] }))} />
        </div>
      )}
      <div className="mt-3">
        <p className="mb-1.5 text-[12.5px] font-medium text-muted">Channel — job message carries token, location, fault, flag, photo</p>
        <Segmented label="channel" value={channel} onChange={setChannel} options={[
          { value: 'whatsapp', label: 'WhatsApp' }, { value: 'sms', label: 'SMS' }, { value: 'call', label: 'Call' }, { value: 'card', label: 'Card' },
        ]} />
      </div>
      <Button className="mt-4" disabled={picked.length === 0}
        onClick={async () => {
          let tk = ticket
          for (const w of chosen) tk = await api.assign(tk.id, w, chosen.length === 1 || w.id === (lead || chosen[0].id), channel, actor)
          onDone(tk)
        }}>Dispatch</Button>
    </Box>
  )
}

function AssessBox({ ticket, onDone, actor }: { ticket: Ticket; onDone: (t: Ticket) => void; actor: string }) {
  const [flags, setFlags] = useState<Assessment[]>([])
  const [lines, setLines] = useState<{ label: string; paise: number }[]>([{ label: '', paise: 0 }])
  const [showCost, setShowCost] = useState(false)
  const total = lines.reduce((s, l) => s + l.paise, 0)
  const items = [
    { v: 'simple' as const, label: 'Simple' },
    { v: 'workforce' as const, label: 'More workforce' },
    { v: 'parts' as const, label: 'Parts / vendor' },
    { v: 'expenditure' as const, label: 'Expenditure' },
  ]
  return (
    <Box title="Worker assessment — entered by manager on behalf of worker">
      <div className="flex flex-wrap gap-2">
        {items.map((i) => (
          <CheckChip key={i.v} selected={flags.includes(i.v)} onClick={() => setFlags((f) => f.includes(i.v) ? f.filter((x) => x !== i.v) : [...f, i.v])}>{i.label}</CheckChip>
        ))}
      </div>
      {flags.includes('expenditure') && !showCost && (
        <Button variant="secondary" className="mt-4" onClick={() => setShowCost(true)}>Build cost proposal</Button>
      )}
      {showCost && (
        <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} transition={spring} className="overflow-hidden">
          <div className="pt-4">
            {lines.map((l, i) => (
              <div key={i} className="mb-2 flex gap-2">
                <TextInput placeholder={i === 0 ? 'Item — material or labour' : 'Another line'} value={l.label}
                  onChange={(e) => setLines((ls) => ls.map((x, j) => j === i ? { ...x, label: e.target.value } : x))} className="flex-1" />
                <TextInput inputMode="decimal" placeholder="₹" value={l.paise ? String(l.paise / 100) : ''}
                  onChange={(e) => setLines((ls) => ls.map((x, j) => j === i ? { ...x, paise: Math.round(parseFloat(e.target.value || '0') * 100) } : x))} className="w-24" />
              </div>
            ))}
            {total > 0 && <p className="token mb-2 text-[13px] text-muted">Total {formatPaise(total)} — stored as integer paise</p>}
            <div className="flex gap-2">
              <Button variant="secondary" className="max-w-36 flex-none" onClick={() => setLines((ls) => [...ls, { label: '', paise: 0 }])}>Add line</Button>
              <Button disabled={total <= 0} onClick={async () => {
                const tk = await api.createProposal(ticket.id, lines.filter((l) => l.label), new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10), actor)
                setShowCost(false); setLines([{ label: '', paise: 0 }]); onDone(tk)
              }}>Send for approval</Button>
            </div>
          </div>
        </motion.div>
      )}
    </Box>
  )
}

function DecisionBox({ ticket, onDone, actor }: { ticket: Ticket; onDone: (t: Ticket) => void; actor: string }) {
  const [kind, setKind] = useState<DecisionKind>('approved')
  const [ceiling, setCeiling] = useState('')
  const [text, setText] = useState('')
  const p = ticket.proposal!
  return (
    <Box title={`Cost proposal v${p.version} — ${formatPaise(p.totalPaise)}`}>
      <ul className="mb-4 space-y-1.5">
        {p.lines.map((l, i) => (
          <li key={i} className="flex justify-between text-[14px]">
            <span>{l.label}</span><span className="token text-muted">{formatPaise(l.paise)}</span>
          </li>
        ))}
      </ul>
      <Segmented label="decision" value={kind} onChange={setKind} options={[
        { value: 'approved', label: 'Approve' }, { value: 'rejected', label: 'Reject' }, { value: 'clarify', label: 'Clarify' }, { value: 'defer', label: 'Defer' },
      ]} />
      {kind === 'approved' && (
        <div className="pt-1">
          <Field label="Approved ceiling (₹)" hint="work above this needs a new version">
            <TextInput inputMode="decimal" value={ceiling} onChange={(e) => setCeiling(e.target.value)} placeholder={String(p.totalPaise / 100)} />
          </Field>
        </div>
      )}
      {kind !== 'approved' && (
        <Field label={kind === 'defer' ? 'Review date and next action' : 'Reason'}>
          <TextInput value={text} onChange={(e) => setText(e.target.value)} placeholder={kind === 'defer' ? 'Revisit 2026-11-01 with new budget' : 'Why this decision'} />
        </Field>
      )}
      <Button className="mt-3" disabled={kind !== 'approved' && !text.trim()}
        onClick={async () => onDone(await api.decide(ticket.id, kind, actor, {
          ceilingPaise: kind === 'approved' ? Math.round(parseFloat(ceiling || String(p.totalPaise / 100)) * 100) : undefined,
          reason: kind !== 'approved' ? text : undefined,
          reviewDate: kind === 'defer' ? text : undefined,
        }))}>
        Record decision
      </Button>
      <p className="pretty mt-3 text-[11.5px] leading-4 text-muted">Binds to proposal v{p.version}. Changed scope or cost above ceiling needs reapproval. Rejection never erases the issue.</p>
    </Box>
  )
}

function MarkDuplicate({ ticket, onDone, actor }: { ticket: Ticket; onDone: (t: Ticket) => void; actor: string }) {
  const [open, setOpen] = useState(false)
  const [token, setToken] = useState('')
  const [err, setErr] = useState('')
  if (!open) return <Button variant="secondary" className="h-11" onClick={() => setOpen(true)}>Duplicate</Button>
  return (
    <div className="flex-1">
      <div className="flex gap-2">
        <TextInput value={token} onChange={(e) => { setToken(e.target.value); setErr('') }} placeholder="DB26C0123" className="token flex-1" />
        <Button className="w-auto max-w-none px-4" onClick={async () => {
          try { onDone(await api.markDuplicate(ticket.id, token, actor)) } catch (e) { setErr(e instanceof Error ? e.message : 'Failed') }
        }}>Link</Button>
      </div>
      {err && <p role="alert" className="mt-1.5 text-[12.5px] font-medium">{err}</p>}
    </div>
  )
}

function Recategorise({ ticket, onDone, lang }: { ticket: Ticket; onDone: (t: Ticket) => void; lang: string }) {
  return (
    <select
      onChange={async (e) => { if (e.target.value) onDone(await api.recategorise(ticket.id, e.target.value, 'manager')) }}
      value="" aria-label="Recategorise"
      className="h-[50px] w-full max-w-44 rounded-[13px] border border-line bg-surface px-3 text-[14px]"
    >
      <option value="">Recategorise…</option>
      {(['carpentry', 'plumbing', 'internet', 'phone', 'projector', 'flooring', 'toilets', 'electrical', 'other'] as const).filter((c) => c !== ticket.categoryCode).map((c) => (
        <option key={c} value={c}>{localName(category(c), lang)} ({category(c).letter})</option>
      ))}
    </select>
  )
}

function CommentsBox({ ticket, onDone, actor }: { ticket: Ticket; onDone: (t: Ticket) => void; actor: string }) {
  const [internal, setInternal] = useState(true)
  const [body, setBody] = useState('')
  const pub = ticket.comments.filter((c) => !c.internal)
  const int = ticket.comments.filter((c) => c.internal)
  return (
    <>
      <SectionLabel>Notes — internal notes never appear in faculty views</SectionLabel>
      <Card className="mx-4 p-4">
        <Segmented label="vis" value={internal ? 'int' : 'pub'} onChange={(v) => setInternal(v === 'int')}
          options={[{ value: 'int', label: 'Internal' }, { value: 'pub', label: 'Visible to reporter' }]} />
        <div className="mt-3 flex gap-2">
          <TextInput value={body} onChange={(e) => setBody(e.target.value)} placeholder={internal ? 'Manager-only note' : 'Comment the reporter sees'} className="flex-1" />
          <Button className="w-auto max-w-none px-4" disabled={!body.trim()} onClick={async () => { onDone(await api.addComment(ticket.id, actor, body.trim(), internal)); setBody('') }}>Add</Button>
        </div>
        {[...int, ...pub].map((c) => (
          <p key={c.id} className="pretty mt-3 rounded-[11px] bg-fg/5 px-3.5 py-2.5 text-[13px] leading-5">
            <span className={`token mr-1 text-[10.5px] font-bold ${c.internal ? 'text-muted' : ''}`}>{c.internal ? 'INT' : 'PUBLIC'}</span>
            {c.body} <span className="text-muted">— {c.actor}</span>
          </p>
        ))}
      </Card>
    </>
  )
}

import type {
  ApiError, Assignment, Category, Draft, Location, Proposal, Ticket, TimelineEvent,
  User, Worker, WorkFlag, Priority, Status, DecisionKind,
} from './types'

const BASE = import.meta.env.VITE_API_BASE_URL as string | undefined

const uid = () => crypto.randomUUID()
const now = () => new Date().toISOString()
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))
const offline = () => !navigator.onLine

export class HttpError extends Error implements ApiError {
  code: string
  fieldErrors?: Record<string, string>
  requestId: string
  constructor(code: string, message: string, fieldErrors?: Record<string, string>, requestId = uid()) {
    super(message)
    this.code = code
    this.fieldErrors = fieldErrors
    this.requestId = requestId
  }
}

export const CATEGORIES: Category[] = [
  { code: 'carpentry', letter: 'C', nameEn: 'Carpentry', nameHi: 'बढ़गीरी', subtypesEn: ['Chair', 'Desk', 'Door', 'Window', 'Cupboard', 'Other'], subtypesHi: ['कुर्सी', 'मेज़', 'दरवाज़ा', 'खिड़की', 'अलमारी', 'अन्य'], active: true },
  { code: 'plumbing', letter: 'P', nameEn: 'Plumbing', nameHi: 'प्लंबिंग', subtypesEn: ['Tap', 'Drain', 'Leak', 'Tank', 'Other'], subtypesHi: ['नल', 'नाली', 'लीक', 'टैंक', 'अन्य'], active: true },
  { code: 'internet', letter: 'I', nameEn: 'Internet', nameHi: 'इंटरनेट', subtypesEn: ['Wi-Fi', 'LAN port', 'Router', 'Other'], subtypesHi: ['वाई-फ़ाई', 'LAN पोर्ट', 'राउटर', 'अन्य'], active: true },
  { code: 'phone', letter: 'T', nameEn: 'Phone', nameHi: 'फ़ोन', subtypesEn: ['Extension', 'Line', 'Other'], subtypesHi: ['एक्सटेंशन', 'लाइन', 'अन्य'], active: true },
  { code: 'projector', letter: 'R', nameEn: 'Projector', nameHi: 'प्रोजेक्टर', subtypesEn: ['Lamp', 'Remote', 'Screen', 'HDMI', 'Other'], subtypesHi: ['लैंप', 'रीमोट', 'स्क्रीन', 'HDMI', 'अन्य'], active: true },
  { code: 'flooring', letter: 'F', nameEn: 'Flooring', nameHi: 'फ़र्श', subtypesEn: ['Tile', 'Crack', 'Other'], subtypesHi: ['टाइल', 'दरार', 'अन्य'], active: true },
  { code: 'toilets', letter: 'W', nameEn: 'Toilets', nameHi: 'शौचालय', subtypesEn: ['Flush', 'Tap', 'Blockage', 'Other'], subtypesHi: ['फ़्लश', 'नल', 'जाम', 'अन्य'], active: true },
  { code: 'electrical', letter: 'E', nameEn: 'Electrical', nameHi: 'बिजली', subtypesEn: ['Fan', 'Light', 'Socket', 'Switchboard', 'Other'], subtypesHi: ['पंखा', 'लाइट', 'सॉकेट', 'स्विचबोर्ड', 'अन्य'], active: true },
  { code: 'other', letter: 'O', nameEn: 'Other', nameHi: 'अन्य', subtypesEn: ['Other'], subtypesHi: ['अन्य'], active: true },
]

export const BUILDINGS: { code: string; nameEn: string; nameHi: string; floors: string[] }[] = [
  { code: 'A', nameEn: 'Block A', nameHi: 'ब्लॉक A', floors: ['Ground', '1', '2', '3'] },
  { code: 'B', nameEn: 'Block B', nameHi: 'ब्लॉक B', floors: ['Ground', '1', '2'] },
  { code: 'C', nameEn: 'Block C', nameHi: 'ब्लॉक C', floors: ['Ground', '1', '2', '3', '4'] },
  { code: 'Lab', nameEn: 'Lab Complex', nameHi: 'प्रयोगशाला', floors: ['Ground', '1'] },
  { code: 'Lib', nameEn: 'Library', nameHi: 'पुस्तकालय', floors: ['Ground', '1', '2'] },
]

const IMPACT_TARGET: Record<Ticket['impact'], { priority: Priority; sla: string }> = {
  safety: { priority: 'P1', sla: '30 min' },
  class_interrupted: { priority: 'P2', sla: '4 working hours' },
  multiple_areas: { priority: 'P3', sla: '2 working days' },
  routine: { priority: 'P4', sla: '5 working days' },
}

function seedWorkers(): Worker[] {
  return [
    { id: 'w1', name: 'Ramesh Kulkarni', phoneMasked: '+91 ••••• 2214', trades: ['carpentry'], area: 'Blocks A, B', language: 'hi', mode: 'whatsapp', kind: 'employee', active: true, workload: 2, lastVerified: '2026-10-01' },
    { id: 'w2', name: 'Suresh Pawar', phoneMasked: '+91 ••••• 7781', trades: ['plumbing', 'toilets'], area: 'All campus', language: 'hi', mode: 'sms', kind: 'employee', active: true, workload: 1, lastVerified: '2026-10-05' },
    { id: 'w3', name: 'Nilesh (V: SparkNet)', phoneMasked: '+91 ••••• 4092', trades: ['internet', 'phone'], area: 'Blocks A, C, Lab', language: 'en', mode: 'whatsapp', kind: 'vendor', active: true, workload: 0, lastVerified: '2026-09-20' },
    { id: 'w4', name: 'Amit Jadhav', phoneMasked: '+91 ••••• 3157', trades: ['electrical'], area: 'All campus', language: 'hi', mode: 'call', kind: 'employee', active: true, workload: 3, lastVerified: '2026-10-12' },
    { id: 'w5', name: 'Ganesh More', phoneMasked: '+91 ••••• 8860', trades: ['projector', 'electrical'], area: 'Lab Complex', language: 'en', mode: 'whatsapp', kind: 'employee', active: false, workload: 0, lastVerified: '2026-08-01' },
  ]
}

function seedTickets(): Ticket[] {
  const t = (partial: Partial<Ticket>): Ticket => ({
    id: uid(), token: 'DB26P0001', reporterId: 'u-fac-1', reporterName: 'S. Deshmukh',
    originalCategoryCode: 'plumbing', categoryCode: 'plumbing', location: { building: 'B', floor: '1', room: '104' },
    title: '', description: '', impact: 'routine', priority: 'P4', assessments: [], status: 'Submitted',
    version: 1, createdAt: now(), updatedAt: now(), assignments: [], attachments: [], events: [], comments: [],
    ...partial,
  })
  return [
    t({ token: 'DB26C0123', categoryCode: 'carpentry', originalCategoryCode: 'carpentry', subtype: 'Chair', title: 'Broken chair in lecture room', description: 'Two chairs near the third row have broken backs. Students are squeezing into fewer seats.', impact: 'class_interrupted', priority: 'P2', status: 'InProgress', flag: 'I', assessments: ['simple'], location: { building: 'A', floor: '2', room: '203' }, createdAt: '2026-10-16T09:12:00+05:30', nextUpdateDue: '2026-10-17T15:00:00+05:30',
      assignments: [{ id: uid(), workerId: 'w1', workerName: 'Ramesh Kulkarni', lead: true, assignedAt: '2026-10-16T10:05:00+05:30', acceptedAt: '2026-10-16T10:21:00+05:30', startedAt: '2026-10-17T09:40:00+05:30', channel: 'whatsapp', delivery: 'read', accepted: true }],
      events: [
        { id: uid(), at: '2026-10-16T09:12:00+05:30', actor: 'S. Deshmukh', action: 'Submitted' },
        { id: uid(), at: '2026-10-16T09:58:00+05:30', actor: 'Facilities manager', action: 'Triaged', detail: 'Priority P2 · flag I' },
        { id: uid(), at: '2026-10-16T10:05:00+05:30', actor: 'Facilities manager', action: 'Assigned', detail: 'Ramesh Kulkarni via WhatsApp' },
        { id: uid(), at: '2026-10-16T10:21:00+05:30', actor: 'Ramesh Kulkarni', action: 'Accepted', detail: 'WhatsApp reply button' },
      ] }),
    t({ token: 'DB26E0087', categoryCode: 'electrical', originalCategoryCode: 'electrical', subtype: 'Fan', title: 'Ceiling fan making noise', description: 'Fan near the last row wobbles and makes a grinding sound. It still runs.', impact: 'routine', priority: 'P4', status: 'Triaged', location: { building: 'C', floor: '1', room: '112' }, createdAt: '2026-10-17T08:30:00+05:30', nextUpdateDue: '2026-10-19T08:30:00+05:30' }),
    t({ token: 'DB26R0011', categoryCode: 'projector', originalCategoryCode: 'projector', subtype: 'HDMI', title: 'Lab projector has no signal', description: 'HDMI port loose; laptop is detected but the image flickers off within a minute. Practical session is blocked.', impact: 'class_interrupted', priority: 'P2', status: 'AwaitingApproval', flag: 'C', assessments: ['parts', 'expenditure'], location: { building: 'Lab', floor: '1', room: 'L-102' }, createdAt: '2026-10-15T11:00:00+05:30', nextUpdateDue: '2026-10-17T11:00:00+05:30',
      assignments: [{ id: uid(), workerId: 'w4', workerName: 'Amit Jadhav', lead: true, assignedAt: '2026-10-15T13:20:00+05:30', acceptedAt: '2026-10-15T13:44:00+05:30', channel: 'call', delivery: 'read', accepted: true }],
      proposal: { id: uid(), version: 1, lines: [{ label: 'HDMI port assembly', paise: 185000 }, { label: 'Labour', paise: 50000 }], totalPaise: 235000, requestedDate: '2026-10-20', state: 'pending' },
      events: [
        { id: uid(), at: '2026-10-15T11:00:00+05:30', actor: 'P. Joshi', action: 'Submitted' },
        { id: uid(), at: '2026-10-15T12:40:00+05:30', actor: 'Facilities manager', action: 'Triaged', detail: 'Priority P2 · flag C' },
        { id: uid(), at: '2026-10-15T13:44:00+05:30', actor: 'Amit Jadhav', action: 'Assessment recorded', detail: 'Parts and expenditure needed' },
        { id: uid(), at: '2026-10-16T10:15:00+05:30', actor: 'Facilities manager', action: 'Cost proposal sent for approval', detail: '₹2,350.00' },
      ] }),
    t({ token: 'DB26W0034', categoryCode: 'toilets', originalCategoryCode: 'toilets', subtype: 'Blockage', title: 'Washroom drain overflowing', description: 'Water pooling outside the ground-floor washroom. Slip hazard near the stairway.', impact: 'safety', priority: 'P1', status: 'Resolved', flag: 'I', assessments: ['workforce'], location: { building: 'A', floor: 'Ground', room: 'W-01' }, createdAt: '2026-10-14T07:55:00+05:30', verifiedByReporter: false,
      events: [
        { id: uid(), at: '2026-10-14T07:55:00+05:30', actor: 'K. Bhosale', action: 'Submitted' },
        { id: uid(), at: '2026-10-14T08:04:00+05:30', actor: 'Facilities manager', action: 'Triaged', detail: 'Priority P1 · flag I' },
        { id: uid(), at: '2026-10-14T10:30:00+05:30', actor: 'Suresh Pawar', action: 'Repair completed', detail: 'Drain cleared, area dried' },
        { id: uid(), at: '2026-10-14T10:32:00+05:30', actor: 'Facilities manager', action: 'Resolved', detail: 'Awaiting reporter verification' },
      ] }),
    t({ token: 'DB26I0052', categoryCode: 'internet', originalCategoryCode: 'internet', subtype: 'Wi-Fi', title: 'No Wi-Fi on second floor Block C', description: 'Access point near staff room shows connected but no internet since Monday morning.', impact: 'multiple_areas', priority: 'P3', status: 'Closed', verifiedByReporter: true, createdAt: '2026-10-08T09:00:00+05:30',
      events: [
        { id: uid(), at: '2026-10-08T09:00:00+05:30', actor: 'A. Shinde', action: 'Submitted' },
        { id: uid(), at: '2026-10-08T16:20:00+05:30', actor: 'Nilesh (V: SparkNet)', action: 'Repair completed', detail: 'Access point rebooted and re-tuned' },
        { id: uid(), at: '2026-10-09T09:10:00+05:30', actor: 'A. Shinde', action: 'Verified and closed' },
      ] }),
  ]
}

const KEY = 'pcms.db.v1'
interface DB { tickets: Ticket[]; workers: Worker[] }

function load(): DB {
  const raw = localStorage.getItem(KEY)
  if (raw) { try { return JSON.parse(raw) as DB } catch { /* reseed */ } }
  const db: DB = { tickets: seedTickets(), workers: seedWorkers() }
  localStorage.setItem(KEY, JSON.stringify(db))
  return db
}
function save(db: DB) { localStorage.setItem(KEY, JSON.stringify(db)) }

function nextToken(db: DB, categoryCode: string): string {
  const cat = CATEGORIES.find((c) => c.code === categoryCode) ?? CATEGORIES[8]
  const year = new Date().getFullYear() % 100
  const same = db.tickets.filter((t) => t.categoryCode === categoryCode && t.token.startsWith(`DB${year}${cat.letter}`))
  const serial = String(same.length + 1).padStart(4, '0')
  return `DB${year}${cat.letter}${serial}`
}

export const ev = (action: string, actor: string, detail?: string): TimelineEvent =>
  ({ id: uid(), at: now(), actor, action, detail })

// ——— session ———
const USERS: Record<string, User> = {
  'DB2101': { id: 'u-fac-1', employeeId: 'DB2101', name: 'S. Deshmukh', role: 'faculty', capabilities: ['ticket.create', 'ticket.track', 'ticket.verify'] },
  'DB0001': { id: 'u-fm-1', employeeId: 'DB0001', name: 'R. Patil', role: 'facility_manager', capabilities: ['queue.view', 'ticket.triage', 'ticket.assign', 'ticket.assess', 'ticket.escalate', 'ticket.close', 'worker.directory'] },
  'DB0002': { id: 'u-mg-1', employeeId: 'DB0002', name: 'V. Kulkarni', role: 'management', capabilities: ['queue.view', 'cost.approve'] },
  'DB0000': { id: 'u-ad-1', employeeId: 'DB0000', name: 'OSSC Admin', role: 'ossc', capabilities: ['queue.view', 'ticket.triage', 'ticket.assign', 'ticket.assess', 'ticket.escalate', 'ticket.close', 'worker.directory', 'worker.manage', 'cost.approve', 'admin.users', 'admin.catalogs', 'admin.locations', 'admin.settings', 'admin.audit'] },
}

const SESSION_KEY = 'pcms.session'

export const api = {
  mock: !BASE,

  async signIn(employeeId: string, password: string): Promise<User> {
    if (offline()) throw new HttpError('offline', 'The network is unavailable. Connect to campus Wi-Fi and try again.')
    await delay(450)
    const user = USERS[employeeId.trim().toUpperCase()]
    if (!user || password.length < 4) throw new HttpError('invalid_credentials', 'Employee ID or password is incorrect. Access is managed by the college roster.')
    sessionStorage.setItem(SESSION_KEY, user.id)
    return user
  },
  restore(): User | null {
    const id = sessionStorage.getItem(SESSION_KEY)
    return id ? Object.values(USERS).find((u) => u.id === id) ?? null : null
  },
  async signOut() { sessionStorage.removeItem(SESSION_KEY); localStorage.removeItem('pcms.drafts') },

  // ——— tickets ———
  async listTickets(scope: 'mine' | 'all', user: User): Promise<Ticket[]> {
    if (BASE) { const r = await fetch(`/api/v1/tickets?scope=${scope}`); if (!r.ok) throw await toErr(r); return r.json() }
    await delay(250)
    const db = load()
    return (scope === 'mine' ? db.tickets.filter((t) => t.reporterId === user.id) : db.tickets)
      .slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  },
  async getTicket(id: string): Promise<Ticket | null> {
    await delay(180)
    return load().tickets.find((t) => t.id === id) ?? null
  },

  async createTicket(user: User, draft: Draft, requestKey: string): Promise<Ticket> {
    if (offline()) throw new HttpError('offline', 'Submission needs the campus network. Your draft is kept on this device.')
    await delay(600)
    const db = load()
    const replay = db.tickets.find((t) => t.requestKey === requestKey && t.reporterId === user.id)
    if (replay) return replay
    if (draft.title.trim().length < 4) throw new HttpError('validation', 'Give the issue a short title.', { title: 'Required' })
    if (!draft.location.building || !draft.location.room) throw new HttpError('validation', 'Building and room are required.', { location: 'Incomplete' })
    const ticket: Ticket = {
      id: uid(), token: nextToken(db, draft.categoryCode), reporterId: user.id, reporterName: user.name,
      originalCategoryCode: draft.categoryCode, categoryCode: draft.categoryCode, subtype: draft.subtype,
      location: draft.location, title: draft.title.trim(), description: draft.description.trim(),
      impact: draft.impact, priority: IMPACT_TARGET[draft.impact].priority, assessments: [], status: 'Submitted',
      version: 1, createdAt: now(), updatedAt: now(), assignments: [], attachments: [],
      events: [ev('Submitted', user.name)], comments: [], requestKey,
      accessNote: draft.accessNote, altContact: draft.altContact,
    }
    db.tickets.unshift(ticket)
    save(db)
    return ticket
  },

  async patchTicket(id: string, patch: Partial<Ticket>, extraEvents: TimelineEvent[], actor: string): Promise<Ticket> {
    await delay(300)
    const db = load()
    const t = db.tickets.find((x) => x.id === id)
    if (!t) throw new HttpError('not_found', 'Ticket not found.')
    Object.assign(t, patch)
    t.version += 1
    t.updatedAt = now()
    t.events = [...t.events, ...extraEvents.map((e) => ({ ...e, actor: e.actor === 'me' ? actor : e.actor }))]
    save(db)
    return { ...t }
  },

  async transition(id: string, to: Status, actor: string, detail?: string): Promise<Ticket> {
    return this.patchTicket(id, { status: to }, [ev(labelStatus(to), 'me', detail)], actor)
  },
  async triage(id: string, priority: Priority, flag: WorkFlag, actor: string): Promise<Ticket> {
    return this.patchTicket(id, { status: 'Triaged', priority, flag }, [ev('Triaged', 'me', `Priority ${priority} · flag ${flag}`)], actor)
  },
  async assign(id: string, worker: Worker, lead: boolean, channel: Assignment['channel'], actor: string): Promise<Ticket> {
    const t = await this.getTicket(id)
    if (!t) throw new HttpError('not_found', 'Ticket not found.')
    const a: Assignment = { id: uid(), workerId: worker.id, workerName: worker.name, lead, assignedAt: now(), channel, delivery: 'sent', accepted: false }
    const next: Ticket = { ...t, assignments: [...t.assignments, a] }
    return this.patchTicket(id, { status: 'Assigned', assignments: next.assignments }, [ev('Assigned', 'me', `${worker.name} · ${channel}${lead ? ' · lead' : ''}`)], actor)
  },
  async acceptAssignment(ticketId: string, assignmentId: string, workerName: string): Promise<Ticket> {
    const t = await this.getTicket(ticketId)
    if (!t) throw new HttpError('not_found', 'Ticket not found.')
    const assignments = t.assignments.map((a) => a.id === assignmentId ? { ...a, accepted: true, acceptedAt: now(), delivery: 'read' as const } : a)
    return this.patchTicket(ticketId, { status: 'InProgress', assignments }, [ev('Accepted', workerName, 'Reply button · WhatsApp')], workerName)
  },
  async resolve(id: string, actor: string, note: string): Promise<Ticket> {
    return this.patchTicket(id, { status: 'Resolved' }, [ev('Resolved', 'me', note)], actor)
  },
  async verify(id: string, user: User): Promise<Ticket> {
    return this.patchTicket(id, { status: 'Closed', verifiedByReporter: true }, [ev('Verified and closed', user.name)], user.name)
  },
  async dispute(id: string, user: User, reason: string): Promise<Ticket> {
    return this.patchTicket(id, { status: 'Triaged', verifiedByReporter: false }, [ev('Disputed — reopened to triage', user.name, reason)], user.name)
  },
  async addComment(id: string, actor: string, body: string, internal: boolean): Promise<Ticket> {
    const t = await this.getTicket(id)
    if (!t) throw new HttpError('not_found', 'Ticket not found.')
    return this.patchTicket(id, { comments: [...t.comments, { id: uid(), at: now(), actor, body, internal }] }, [], actor)
  },
  async attachMedia(id: string, att: { kind: 'photo' | 'video'; name: string; sizeBytes: number; dataUrl?: string }): Promise<Ticket> {
    const t = await this.getTicket(id)
    if (!t) throw new HttpError('not_found', 'Ticket not found.')
    return this.patchTicket(id, { attachments: [...t.attachments, { id: uid(), ...att, state: 'available' }] }, [ev('Evidence added', 'me', att.name)], 'me')
  },
  async setFlag(id: string, flag: WorkFlag, actor: string): Promise<Ticket> {
    return this.patchTicket(id, { flag }, [ev('Flag set', 'me', `Work type ${flag}`)], actor)
  },
  async recategorise(id: string, code: string, actor: string): Promise<Ticket> {
    return this.patchTicket(id, { categoryCode: code }, [ev('Recategorised', 'me', CATEGORIES.find((c) => c.code === code)?.nameEn ?? code)], actor)
  },
  async markDuplicate(id: string, canonicalToken: string, actor: string): Promise<Ticket> {
    const t = await this.getTicket(id)
    if (!t) throw new HttpError('not_found', 'Ticket not found.')
    const canonical = load().tickets.find((x) => x.token === canonicalToken.trim().toUpperCase())
    if (!canonical) throw new HttpError('validation', 'No open ticket carries that token.', { token: 'Unknown token' })
    return this.patchTicket(id, { status: 'Duplicate', duplicateOf: canonical.id }, [ev('Marked duplicate', 'me', `of ${canonical.token}`)], actor)
  },

  // ——— costs ———
  async createProposal(id: string, lines: Proposal['lines'], requestedDate: string, actor: string): Promise<Ticket> {
    const t = await this.getTicket(id)
    if (!t) throw new HttpError('not_found', 'Ticket not found.')
    const proposal: Proposal = { id: uid(), version: (t.proposal?.version ?? 0) + 1, lines, totalPaise: lines.reduce((s, l) => s + l.paise, 0), requestedDate, state: 'pending' }
    return this.patchTicket(id, { status: 'AwaitingApproval', proposal }, [ev('Cost proposal sent for approval', 'me', formatPaise(proposal.totalPaise))], actor)
  },
  async decide(id: string, kind: DecisionKind, actor: string, opts: { ceilingPaise?: number; reason?: string; reviewDate?: string; conditions?: string }): Promise<Ticket> {
    const t = await this.getTicket(id)
    if (!t?.proposal) throw new HttpError('not_found', 'No proposal on this ticket.')
    const proposal: Proposal = { ...t.proposal, state: kind, decidedBy: actor, decidedAt: now(), ...opts }
    const status: Status = kind === 'approved' ? 'InProgress' : 'OnHold'
    return this.patchTicket(id, { proposal, status }, [ev(kind === 'approved' ? 'Cost approved' : `Decision: ${kind}`, 'me', kind === 'approved' ? `Ceiling ${formatPaise(opts.ceilingPaise ?? proposal.totalPaise)}` : (opts.reason ?? formatPaise(proposal.totalPaise)))], actor)
  },

  // ——— workers ———
  async listWorkers(): Promise<Worker[]> { await delay(200); return load().workers },
  async setWorkerActive(id: string, active: boolean): Promise<Worker> {
    const db = load()
    const w = db.workers.find((x) => x.id === id)
    if (!w) throw new HttpError('not_found', 'Worker not found.')
    w.active = active
    save(db)
    return { ...w }
  },

  async findDuplicates(location: Location, categoryCode: string): Promise<Ticket[]> {
    await delay(150)
    return load().tickets.filter((t) =>
      t.categoryCode === categoryCode && t.location.room === location.room &&
      !['Closed', 'Cancelled', 'Rejected', 'Duplicate'].includes(t.status))
  },
}

async function toErr(r: Response): Promise<ApiError> {
  const body = await r.json().catch(() => ({}))
  return new HttpError(body.code ?? String(r.status), body.message ?? 'Request failed.', body.field_errors, body.request_id)
}

export function formatPaise(p: number): string {
  return '₹' + (p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
export function labelStatus(s: Status): string {
  const map: Record<Status, string> = {
    Submitted: 'Submitted', Triaged: 'Triaged', Assigned: 'Assigned', InProgress: 'In progress',
    OnHold: 'On hold', AwaitingApproval: 'Awaiting approval', Resolved: 'Resolved', Closed: 'Closed',
    Cancelled: 'Cancelled', Rejected: 'Rejected', Duplicate: 'Duplicate',
  }
  return map[s]
}
export function category(code: string): Category {
  return CATEGORIES.find((c) => c.code === code) ?? CATEGORIES[8]
}

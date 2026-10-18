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
  { code: 'carpentry', letter: 'C', nameEn: 'Carpentry', nameHi: 'बढ़गीरी', nameKn: 'ಬಡಗಲಿ ಕೆಲಸ', subtypesEn: ['Chair', 'Desk', 'Door', 'Window', 'Cupboard', 'Other'], subtypesHi: ['कुर्सी', 'मेज़', 'दरवाज़ा', 'खिड़की', 'अलमारी', 'अन्य'], subtypesKn: ['ಕುರ್ಚಿ', 'ಮೇಜು', 'ಬಾಗಿಲು', 'ಕಿಟಕಿ', 'ಅಲ್ಮಾರಿ', 'ಇತರೆ'], active: true },
  { code: 'plumbing', letter: 'P', nameEn: 'Plumbing', nameHi: 'प्लंबिंग', nameKn: 'ಕೊಳಾಯಿ ಕೆಲಸ', subtypesEn: ['Tap', 'Drain', 'Leak', 'Tank', 'Other'], subtypesHi: ['नल', 'नाली', 'लीक', 'टैंक', 'अन्य'], subtypesKn: ['ನಳಿಕೆ', 'ಒಳಚರಂಡಿ', 'ಸೋರಿಕೆ', 'ಟ್ಯಾಂಕ್', 'ಇತರೆ'], active: true },
  { code: 'internet', letter: 'I', nameEn: 'Internet', nameHi: 'इंटरनेट', nameKn: 'ಇಂಟರ್ನೆಟ್', subtypesEn: ['Wi-Fi', 'LAN port', 'Router', 'Other'], subtypesHi: ['वाई-फ़ाई', 'LAN पोर्ट', 'राउटर', 'अन्य'], subtypesKn: ['ವೈ-ಫೈ', 'LAN ಪೋರ್ಟ್', 'ರೌಟರ್', 'ಇತರೆ'], active: true },
  { code: 'phone', letter: 'T', nameEn: 'Phone', nameHi: 'फ़ोन', nameKn: 'ದೂರವಾಣಿ', subtypesEn: ['Extension', 'Line', 'Other'], subtypesHi: ['एक्सटेंशन', 'लाइन', 'अन्य'], subtypesKn: ['ಎಕ್ಸ್ಟೆನ್ಷನ್', 'ಲೈನ್', 'ಇತರೆ'], active: true },
  { code: 'projector', letter: 'R', nameEn: 'Projector', nameHi: 'प्रोजेक्टर', nameKn: 'ಪ್ರೊಜೆಕ್ಟರ್', subtypesEn: ['Lamp', 'Remote', 'Screen', 'HDMI', 'Other'], subtypesHi: ['लैंप', 'रीमोट', 'स्क्रीन', 'HDMI', 'अन्य'], subtypesKn: ['ಲ್ಯಾಂಪ್', 'ರಿಮೋಟ್', 'ತೆರೆ', 'HDMI', 'ಇತರೆ'], active: true },
  { code: 'flooring', letter: 'F', nameEn: 'Flooring', nameHi: 'फ़र्श', nameKn: 'ನೆಲ ಹಾಸು', subtypesEn: ['Tile', 'Crack', 'Other'], subtypesHi: ['टाइल', 'दरार', 'अन्य'], subtypesKn: ['ಟೈಲ್', 'ಬಿರುಕು', 'ಇತರೆ'], active: true },
  { code: 'toilets', letter: 'W', nameEn: 'Toilets', nameHi: 'शौचालय', nameKn: 'ಶೌಚಾಲಯ', subtypesEn: ['Flush', 'Tap', 'Blockage', 'Other'], subtypesHi: ['फ़्लश', 'नल', 'जाम', 'अन्य'], subtypesKn: ['ಫ್ಲಶ್', 'ನಳಿಕೆ', 'ಅಡ್ಡಿ', 'ಇತರೆ'], active: true },
  { code: 'electrical', letter: 'E', nameEn: 'Electrical', nameHi: 'बिजली', nameKn: 'ವಿದ್ಯುತ್', subtypesEn: ['Fan', 'Light', 'Socket', 'Switchboard', 'Other'], subtypesHi: ['पंखा', 'लाइट', 'सॉकेट', 'स्विचबोर्ड', 'अन्य'], subtypesKn: ['ಪಂಖ', 'ಬೆಳಕು', 'ಸಾಕೆಟ್', 'ಸ್ವಿಚ್‌ಬೋರ್ಡ್', 'ಇತರೆ'], active: true },
  { code: 'other', letter: 'O', nameEn: 'Other', nameHi: 'अन्य', nameKn: 'ಇತರೆ', subtypesEn: ['Other'], subtypesHi: ['अन्य'], subtypesKn: ['ಇತರೆ'], active: true },
]

export const BUILDINGS: { code: string; nameEn: string; nameHi: string; nameKn: string; floors: string[] }[] = [
  { code: 'A', nameEn: 'Block A', nameHi: 'ब्लॉक A', nameKn: 'ಬ್ಲಾಕ್ A', floors: ['Ground', '1', '2', '3'] },
  { code: 'B', nameEn: 'Block B', nameHi: 'ब्लॉक B', nameKn: 'ಬ್ಲಾಕ್ B', floors: ['Ground', '1', '2'] },
  { code: 'C', nameEn: 'Block C', nameHi: 'ब्लॉक C', nameKn: 'ಬ್ಲಾಕ್ C', floors: ['Ground', '1', '2', '3', '4'] },
  { code: 'Lab', nameEn: 'Lab Complex', nameHi: 'प्रयोगशाला', nameKn: 'ಪ್ರಯೋಗಾಲಯ', floors: ['Ground', '1'] },
  { code: 'Lib', nameEn: 'Library', nameHi: 'पुस्तकालय', nameKn: 'ಗ್ರಂಥಾಲಯ', floors: ['Ground', '1', '2'] },
]

export function localName(item: { nameEn: string; nameHi: string; nameKn: string }, lang: string): string {
  return lang === 'hi' ? item.nameHi : lang === 'kn' ? item.nameKn : item.nameEn
}
export function localSubtypes(cat: Category, lang: string): string[] {
  return lang === 'hi' ? cat.subtypesHi : lang === 'kn' ? cat.subtypesKn : cat.subtypesEn
}

const IMPACT_TARGET: Record<Ticket['impact'], { priority: Priority; sla: string }> = {
  safety: { priority: 'P1', sla: '30 min' },
  class_interrupted: { priority: 'P2', sla: '4 working hours' },
  multiple_areas: { priority: 'P3', sla: '2 working days' },
  routine: { priority: 'P4', sla: '5 working days' },
}

// The mock database starts empty — no fabricated tickets, workers or history.
// `demoSeed()` exists only for walkthroughs and is triggered deliberately from
// the admin portal; it is clearly labelled demo data.

function demoWorkers(): Worker[] {
  return [
    { id: 'w1', name: 'Carpenter — worker 1', phoneMasked: '+91 ••••• 2214', trades: ['carpentry'], area: 'Blocks A, B', language: 'hi', mode: 'whatsapp', kind: 'employee', active: true, workload: 0, lastVerified: '2026-10-01' },
    { id: 'w2', name: 'Plumber — worker 2', phoneMasked: '+91 ••••• 7781', trades: ['plumbing', 'toilets'], area: 'All campus', language: 'hi', mode: 'sms', kind: 'employee', active: true, workload: 0, lastVerified: '2026-10-05' },
    { id: 'w3', name: 'Network vendor', phoneMasked: '+91 ••••• 4092', trades: ['internet', 'phone'], area: 'Blocks A, C, Lab', language: 'en', mode: 'whatsapp', kind: 'vendor', active: true, workload: 0, lastVerified: '2026-09-20' },
    { id: 'w4', name: 'Electrician — worker 4', phoneMasked: '+91 ••••• 3157', trades: ['electrical', 'projector'], area: 'All campus', language: 'kn', mode: 'call', kind: 'employee', active: true, workload: 0, lastVerified: '2026-10-12' },
  ]
}

const KEY = 'pcms.db.v2'
try { localStorage.removeItem('pcms.db.v1') } catch { /* private mode */ }
interface DB { tickets: Ticket[]; workers: Worker[] }

function load(): DB {
  const raw = localStorage.getItem(KEY)
  if (raw) { try { return JSON.parse(raw) as DB } catch { /* reinit */ } }
  const db: DB = { tickets: [], workers: [] }
  localStorage.setItem(KEY, JSON.stringify(db))
  return db
}
function save(db: DB) { localStorage.setItem(KEY, JSON.stringify(db)) }

export function demoSeed() {
  const db = load()
  db.workers = demoWorkers()
  save(db)
}
export function demoReset() { localStorage.removeItem(KEY) }
export function hasDemoData(): boolean { const db = load(); return db.workers.length > 0 || db.tickets.length > 0 }

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

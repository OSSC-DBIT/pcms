export type Role = 'faculty' | 'ossc' | 'facility_manager' | 'management' | 'principal'

export interface User {
  id: string
  email: string
  name: string
  role: Role
  capabilities: Capability[]
}

export type Capability =
  | 'ticket.create' | 'ticket.track' | 'ticket.verify'
  | 'queue.view' | 'ticket.triage' | 'ticket.assign' | 'ticket.assess' | 'ticket.escalate' | 'ticket.close'
  | 'ticket.attach'
  | 'cost.approve' | 'cost.principal'
  | 'admin.users' | 'admin.catalogs' | 'admin.locations' | 'admin.settings' | 'admin.audit' | 'admin.tickets'

/** What the sign-in flow needs next. Protected screens work only once this is 'done'. */
export type SignInStep = 'totp' | 'change_password' | 'enrol_totp' | 'done'

export interface StepResult {
  user: User
  next: SignInStep
  csrfToken: string
  enrolment: { secret: string; uri: string } | null
  recoveryCodes: string[] | null
}

export type Status =
  | 'Submitted' | 'Triaged' | 'Assigned' | 'InProgress' | 'OnHold' | 'AwaitingApproval'
  | 'Resolved' | 'Closed' | 'Cancelled' | 'Rejected' | 'Duplicate'

export const TERMINAL: Status[] = ['Closed', 'Cancelled', 'Rejected', 'Duplicate']

export type WorkFlag = 'I' | 'C' | 'P'
export type Assessment = 'simple' | 'workforce' | 'parts' | 'expenditure'
/** Severity the reporter picks: red (urgent or unsafe), orange (soon), green (routine). */
export type Impact = 'red' | 'orange' | 'green'
export const IMPACTS: Impact[] = ['red', 'orange', 'green']
export type Channel = 'whatsapp' | 'sms' | 'call' | 'card'

export interface Location {
  building: string
  /** Free text only when building is the CUSTOM sentinel. */
  customLocation?: string
  /** A configured department/area, or free text for Custom Location. */
  department?: string
  floor: string
  room: string
  outdoors?: boolean
  landmark?: string
}

export interface Attachment {
  id: string
  /** Documents (PDF, Word) are staff-only and never returned to faculty. */
  kind: 'photo' | 'video' | 'document'
  name: string
  sizeBytes: number
  state: 'pending' | 'scanning' | 'available' | 'failed'
  failureReason?: string | null
  /** Who added it. Faculty see their own name or "Facilities team", never a staff name. */
  uploadedBy: string
  uploadedAt?: string | null
  /** Authorised download URL; only set when state is 'available'. */
  url?: string | null
}

export interface TimelineEvent {
  id: string
  at: string
  actor: string
  action: string
  detail?: string | null
  delegatedWorker?: string | null
}

export interface Comment {
  id: string
  at: string
  actor: string
  body: string
  internal: boolean
}

export type DecisionKind = 'approved' | 'rejected' | 'clarify' | 'defer' | 'escalated'
/** Who decides a pending proposal. Management may escalate to the principal. */
export type ProposalStage = 'management' | 'principal'

export interface Proposal {
  id: string
  version: number
  lines: { label: string; paise: number }[]
  totalPaise: number
  requestedDate: string
  requestedBy: string
  requestedById: string
  remedy: string
  state: 'pending' | DecisionKind | 'superseded'
  stage: ProposalStage
  ceilingPaise?: number | null
  conditions?: string | null
  decidedBy?: string | null
  decidedAt?: string | null
  reason?: string | null
  reviewDate?: string | null
}

/** List rows: the ticket without its timeline, comments and evidence. */
export interface TicketSummary {
  id: string
  token: string
  reporterId: string
  reporterName: string
  originalCategoryCode: string
  categoryCode: string
  subtype?: string | null
  location: Location
  title: string
  impact: Impact
  flag?: WorkFlag | null
  assessments: Assessment[]
  status: Status
  version: number
  createdAt: string
  updatedAt: string
  nextUpdateDue?: string | null
  duplicateOf?: string | null
  verifiedByReporter?: boolean | null
  /** Internal worker or vendor name. Always null for faculty. */
  workerName?: string | null
  /** Never present for faculty. */
  proposal?: Proposal | null
  /** Machine translations of typed text: { original: { en|kn|hi: text } }. Missing while still being translated. */
  translations?: Record<string, Partial<Record<'en' | 'kn' | 'hi', string>>>
}

export interface Rating {
  stars: number
  comment?: string | null
  createdAt: string
}

export interface Ticket extends TicketSummary {
  description: string
  accessNote?: string | null
  altContact?: string | null
  attachments: Attachment[]
  events: TimelineEvent[]
  comments: Comment[]
  holdReason?: string | null
  holdReviewDate?: string | null
  rating?: Rating | null
  /** What the repair actually cost, recorded when it was marked fixed. Always null for faculty. */
  actualCostPaise?: number | null
}

export interface LowRating {
  ticketId: string
  token: string
  title: string
  stars: number
  comment?: string | null
  createdAt: string
  category?: string | null
  building?: string | null
  room?: string | null
}

export interface Category { code: string; letter: string; nameEn: string; nameHi: string; nameKn: string; subtypesEn: string[]; subtypesHi: string[]; subtypesKn: string[]; active: boolean }
export interface Building { code: string; nameEn: string; nameHi: string; nameKn: string; floors: string[]; departments: string[]; departmentsKn: string[]; active: boolean }

export interface Draft {
  key: string
  savedAt: string
  title: string
  description: string
  categoryCode: string
  subtype?: string
  otherDetail?: string
  location: Location
  impact: Impact
  accessNote?: string
  altContact?: string
}

export interface AdminUser {
  id: string
  email: string
  name: string
  role: Role
  department?: string | null
  position?: string | null
  active: boolean
  mustChangePassword: boolean
  tempPasswordExpiresAt: string | null
  passwordChangedAt: string | null
  totpEnabled: boolean
  lastLoginAt: string | null
  createdAt: string
  version: number
}

export interface Credential { user: AdminUser; temporaryPassword: string; expiresAt: string | null }

export interface Page<T> { items: T[]; total: number; page: number; pageSize: number }

// ---------- reports ----------

export interface Percentiles { count: number; medianHours: number | null; p90Hours: number | null }

/** One calendar month of the annual overview. Buckets use Asia/Kolkata. */
export interface MonthPoint {
  month: number
  created: number
  resolved: number
  pending: number
  overdue: number
  avgResolutionHours: number | null
}

export interface AnnualReport {
  year: number
  months: MonthPoint[]
  previousCreated: number[]
  previousResolved: number[]
  years: number[]
}

export interface Report {
  generatedAt: string
  days: number
  openByStatus: Record<string, number>
  openBySeverity: Record<string, number>
  untriaged: number
  overdueUpdates: number
  pendingApprovals: number
  holdsByReason: { reason: string | null; count: number }[]
  disputes: number
  failedNotifications: number
  repeatFaults: { building: string | null; room: string | null; category: string | null; count: number }[]
  triageTime: Percentiles
  resolutionTime: Percentiles
  /** Null for roles that do not decide spending (the facility manager). */
  approvedPaise: number | null
  ratings: {
    count: number
    average: number | null
    distribution: Record<string, number>
    low: LowRating[]
  }
  /** Tickets raised in the period per building and department. */
  byDepartment: DepartmentRow[]
  /** Tickets raised in the period per type (category code). */
  byType: { category: string; total: number; open: number; fixed: number }[]
}

export interface DepartmentRow {
  building: string | null
  department: string | null
  total: number
  open: number
  fixed: number
  overdue: number
  /** Sum of recorded actual costs. Null for roles that do not see spending. */
  actualPaise: number | null
}

// ---------- expenditure ----------

export type ExpenditureStatus =
  | 'pending_principal' | 'pending_management' | 'approved' | 'rejected' | 'clarify' | 'defer' | 'superseded'

/** One expenditure request. An escalated request is shown once, with its final decision. */
export interface ExpenditureItem {
  ticketId: string
  token: string
  title: string
  category: string
  building: string | null
  department: string | null
  raisedAt: string
  requestedBy: string
  estimatePaise: number
  status: ExpenditureStatus
  decidedBy: string | null
  decidedAt: string | null
  approvedPaise: number | null
  /** What the repair actually cost, if recorded when it was marked fixed. */
  actualPaise: number | null
  escalated: boolean
  note: string | null
}

export interface Expenditure {
  period: string
  requests: number
  requestedPaise: number
  approvedPaise: number
  pendingPaise: number
  /** Every repair marked fixed in the period with a recorded actual cost, with or without a request. */
  actualPaise: number
  actualCount: number
  approvedCount: number
  pendingCount: number
  rejectedCount: number
  byCategory: { category: string; requests: number; requestedPaise: number; approvedPaise: number }[]
  /** Spending per building and department in the period: requests raised, and actual costs of repairs fixed. */
  byDepartment: ExpenditureDepartment[]
  items: ExpenditureItem[]
}

export interface ExpenditureDepartment {
  building: string | null
  department: string | null
  requests: number
  requestedPaise: number
  approvedPaise: number
  pendingPaise: number
  repairs: number
  actualPaise: number
}

// ---------- audit ----------

export interface AuditEvent {
  id: number
  at: string
  actorLabel: string
  action: string
  entityType: string
  entityId: string
  reason: string | null
  delegatedWorker: string | null
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
  requestId: string | null
}

/** Server-side sort order for the ticket list. */
export type TicketSort = 'newest' | 'oldest' | 'severity' | 'updated'

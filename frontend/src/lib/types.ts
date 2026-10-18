export type Role = 'faculty' | 'ossc' | 'facility_manager' | 'management'

export interface User {
  id: string
  employeeId: string
  name: string
  role: Role
  capabilities: Capability[]
}

export type Capability =
  | 'ticket.create' | 'ticket.track' | 'ticket.verify'
  | 'queue.view' | 'ticket.triage' | 'ticket.assign' | 'ticket.assess' | 'ticket.escalate' | 'ticket.close'
  | 'worker.directory' | 'worker.manage'
  | 'cost.approve'
  | 'admin.users' | 'admin.catalogs' | 'admin.locations' | 'admin.settings' | 'admin.audit'

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

export type Priority = 'P1' | 'P2' | 'P3' | 'P4'
export type WorkFlag = 'I' | 'C' | 'P'
export type Assessment = 'simple' | 'workforce' | 'parts' | 'expenditure'
export type Impact = 'safety' | 'class_interrupted' | 'multiple_areas' | 'routine'
export type Channel = 'whatsapp' | 'sms' | 'call' | 'card'

export interface Location {
  building: string
  floor: string
  room: string
  outdoors?: boolean
  landmark?: string
}

export interface Attachment {
  id: string
  kind: 'photo' | 'video'
  name: string
  sizeBytes: number
  state: 'pending' | 'scanning' | 'available' | 'failed'
  failureReason?: string | null
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

export interface Assignment {
  id: string
  workerId: string
  workerName: string
  lead: boolean
  assignedAt: string
  acceptedAt?: string | null
  startedAt?: string | null
  releasedAt?: string | null
  channel: Channel
  delivery: 'queued' | 'sent' | 'delivered' | 'read' | 'failed' | 'unknown' | 'not_applicable'
  accepted: boolean
}

export type DecisionKind = 'approved' | 'rejected' | 'clarify' | 'defer'

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
  priority: Priority
  flag?: WorkFlag | null
  assessments: Assessment[]
  status: Status
  version: number
  createdAt: string
  updatedAt: string
  nextUpdateDue?: string | null
  duplicateOf?: string | null
  verifiedByReporter?: boolean | null
  assignments: Assignment[]
  /** Never present for faculty. */
  proposal?: Proposal | null
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
}

export interface Worker {
  id: string
  name: string
  phoneMasked: string
  trades: string[]
  area: string
  language: string
  mode: 'whatsapp' | 'sms' | 'call'
  kind: 'employee' | 'vendor'
  active: boolean
  workload: number
  lastVerified?: string | null
  version: number
}

export interface Category { code: string; letter: string; nameEn: string; nameHi: string; subtypesEn: string[]; subtypesHi: string[]; active: boolean }
export interface Building { code: string; nameEn: string; nameHi: string; floors: string[] }

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
  employeeId: string
  name: string
  email: string | null
  role: Role
  active: boolean
  mustChangePassword: boolean
  tempPasswordExpiresAt: string | null
  totpEnabled: boolean
  lastLoginAt: string | null
  createdAt: string
  version: number
}

export interface Credential { user: AdminUser; temporaryPassword: string; expiresAt: string }

export interface Page<T> { items: T[]; total: number; page: number; pageSize: number }

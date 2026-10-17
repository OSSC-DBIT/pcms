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

export type Status =
  | 'Submitted' | 'Triaged' | 'Assigned' | 'InProgress' | 'OnHold' | 'AwaitingApproval'
  | 'Resolved' | 'Closed' | 'Cancelled' | 'Rejected' | 'Duplicate'

export type Priority = 'P1' | 'P2' | 'P3' | 'P4'
export type WorkFlag = 'I' | 'C' | 'P'
export type Assessment = 'simple' | 'workforce' | 'parts' | 'expenditure'

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
  state: 'pending' | 'uploading' | 'available' | 'failed'
  dataUrl?: string
}

export interface TimelineEvent {
  id: string
  at: string
  actor: string
  action: string
  detail?: string
  delegatedWorker?: string
}

export interface Comment {
  id: string
  at: string
  actor: string
  body: string
  internal: boolean
}

export interface Ticket {
  id: string
  token: string
  reporterId: string
  reporterName: string
  originalCategoryCode: string
  categoryCode: string
  subtype?: string
  location: Location
  title: string
  description: string
  impact: 'safety' | 'class_interrupted' | 'multiple_areas' | 'routine'
  accessNote?: string
  altContact?: string
  priority: Priority
  flag?: WorkFlag
  assessments: Assessment[]
  status: Status
  version: number
  createdAt: string
  updatedAt: string
  nextUpdateDue?: string
  duplicateOf?: string
  parentId?: string
  assignments: Assignment[]
  attachments: Attachment[]
  events: TimelineEvent[]
  comments: Comment[]
  proposal?: Proposal
  verifiedByReporter?: boolean
  requestKey?: string
}

export interface Assignment {
  id: string
  workerId: string
  workerName: string
  lead: boolean
  assignedAt: string
  acceptedAt?: string
  startedAt?: string
  channel: 'whatsapp' | 'sms' | 'call' | 'card'
  delivery: 'queued' | 'sent' | 'delivered' | 'read' | 'failed' | 'unknown'
  accepted: boolean
  releasedAt?: string
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
  lastVerified: string
}

export type DecisionKind = 'approved' | 'rejected' | 'clarify' | 'defer'

export interface Proposal {
  id: string
  version: number
  lines: { label: string; paise: number }[]
  totalPaise: number
  requestedDate: string
  state: 'pending' | DecisionKind
  ceilingPaise?: number
  conditions?: string
  decidedBy?: string
  decidedAt?: string
  reason?: string
  reviewDate?: string
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
  location: Location
  impact: Ticket['impact']
  accessNote?: string
  altContact?: string
}

export interface ApiError { code: string; message: string; fieldErrors?: Record<string, string>; requestId: string }

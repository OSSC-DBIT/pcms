/**
 * PCMS API client. Every call goes to the real backend; there is no mock mode.
 * The server decides who the actor is from the session, so no call takes an
 * "actor" argument, and every state change carries the version the user saw.
 */
import { HttpError, qs, request, requestBlob, setCsrf } from './http'
import { resetCatalogs } from './catalog'
import { unsubscribeThisDevice } from './push'
import type {
  AdminUser, Assessment, AuditEvent, Channel, Credential, DecisionKind, Draft, Location, Page,
  Priority, Proposal, Report, Status, StepResult, Ticket, TicketSort, TicketSummary, User, WorkFlag, Worker,
} from './types'

export { HttpError } from './http'
export { category } from './catalog'

const DRAFTS_KEY = 'pcms.drafts'

export interface CreatedTicket {
  id: string
  token: string
  status: Status
  version: number
  createdAt: string
  attachmentUploadAllowed: boolean
}

/** Everything the ticket list can be narrowed by. All of it is applied by the server. */
export interface TicketFilters {
  scope: 'mine' | 'queue'
  status?: Status[]
  open?: boolean
  search?: string
  category?: string
  flag?: WorkFlag
  priority?: Priority
  building?: string
  worker?: string
  sort?: TicketSort
  page?: number
  pageSize?: number
}

export type TransitionAction =
  | { action: 'triage'; priority: Priority; flag?: WorkFlag }
  | { action: 'set_priority'; priority: Priority; reason: string }
  | { action: 'set_flag'; flag: WorkFlag }
  | { action: 'recategorise'; categoryCode: string; reason?: string }
  | { action: 'hold'; reason: string; owner: string; nextAction: string; reviewDate: string }
  | { action: 'resume'; reason?: string }
  | { action: 'resolve'; note: string; evidenceNote?: string }
  | { action: 'verify' }
  | { action: 'dispute'; reason: string }
  | { action: 'reopen'; reason: string }
  | { action: 'duplicate'; canonicalToken: string; reason?: string }
  | { action: 'reject'; reason: string }
  | { action: 'cancel'; reason: string }
  | { action: 'close_unverified'; reason: string }

export const api = {
  // ---------- session ----------
  async signIn(employeeId: string, password: string): Promise<StepResult> {
    const r = await request<StepResult>('POST', '/session', { body: { employeeId, password }, quiet401: true })
    setCsrf(r.csrfToken)
    return r
  },
  async submitTotp(code: string): Promise<StepResult> {
    const r = await request<StepResult>('POST', '/session/totp', { body: { code }, quiet401: true })
    setCsrf(r.csrfToken)
    return r
  },
  async changePassword(currentPassword: string, newPassword: string): Promise<StepResult> {
    const r = await request<StepResult>('POST', '/session/password', { body: { currentPassword, newPassword }, quiet401: true })
    setCsrf(r.csrfToken)
    return r
  },
  /** Current identity, or null when there is no fully signed-in session. */
  async me(): Promise<User | null> {
    try {
      const r = await request<User & { csrfToken: string }>('GET', '/me', { quiet401: true })
      setCsrf(r.csrfToken)
      const { csrfToken: _ignored, ...user } = r
      void _ignored
      return user
    } catch (err) {
      if (err instanceof HttpError && err.status === 401) return null
      throw err
    }
  },
  async signOut(): Promise<void> {
    try {
      await unsubscribeThisDevice().catch(() => undefined)
      await request<void>('DELETE', '/session', { quiet401: true })
    } catch {
      // Already signed out on the server; still clear local state.
    } finally {
      clearLocalData()
    }
  },

  // ---------- tickets ----------
  listTickets(params: TicketFilters): Promise<Page<TicketSummary>> {
    return request('GET', `/tickets${qs({
      scope: params.scope, status: params.status?.join(','), open: params.open,
      search: params.search, category: params.category, flag: params.flag, priority: params.priority,
      building: params.building, worker: params.worker, sort: params.sort,
      page: params.page, pageSize: params.pageSize ?? 25,
    })}`)
  },
  async getTicket(id: string): Promise<Ticket | null> {
    try {
      return await request<Ticket>('GET', `/tickets/${encodeURIComponent(id)}`)
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) return null
      throw err
    }
  },
  /** Open reports at the same place and category; no identities or private notes. */
  findDuplicates(location: Location, categoryCode: string): Promise<{ token: string; title: string; status: Status }[]> {
    return request('GET', `/tickets/duplicates${qs({ category: categoryCode, building: location.building, room: location.room, outdoors: location.outdoors })}`)
  },
  /** Idempotent: the same requestKey and body returns the original ticket. */
  createTicket(draft: Draft, requestKey: string): Promise<CreatedTicket> {
    return request('POST', '/tickets', {
      body: {
        clientRequestId: requestKey,
        categoryCode: draft.categoryCode,
        subtype: draft.subtype || null,
        otherDetail: draft.otherDetail?.trim() || null,
        location: draft.location,
        title: draft.title.trim(),
        description: draft.description.trim(),
        impact: draft.impact,
        accessNote: draft.accessNote?.trim() || null,
        altContact: draft.altContact?.trim() || null,
      },
    })
  },
  transition(ticket: Pick<Ticket, 'id' | 'version'>, action: TransitionAction): Promise<Ticket> {
    return request('POST', `/tickets/${ticket.id}/transitions`, { body: { ...action, expectedVersion: ticket.version } })
  },
  addComment(ticket: Pick<Ticket, 'id'>, body: string, internal: boolean): Promise<Ticket> {
    return request('POST', `/tickets/${ticket.id}/comments`, { body: { body, internal } })
  },
  uploadAttachment(ticketId: string, file: File, onProgress?: (fraction: number) => void): Promise<Ticket['attachments'][number]> {
    // XHR, not fetch, for upload progress.
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      xhr.open('POST', `/api/v1/tickets/${encodeURIComponent(ticketId)}/attachments`)
      xhr.withCredentials = true
      const m = document.cookie.match(/(?:^|;\s*)pcms_csrf=([^;]+)/)
      if (m) xhr.setRequestHeader('X-CSRF-Token', decodeURIComponent(m[1]))
      xhr.setRequestHeader('Accept', 'application/json')
      xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total) }
      xhr.onerror = () => reject(new HttpError(0, 'offline', 'Upload interrupted. Your ticket is safe; retry the file.'))
      xhr.onload = () => {
        let data: Record<string, unknown> = {}
        try { data = JSON.parse(xhr.responseText) } catch { /* not JSON */ }
        if (xhr.status >= 200 && xhr.status < 300) resolve(data as never)
        else reject(new HttpError(xhr.status, String(data.code ?? xhr.status), String(data.message ?? 'Upload failed.'),
          data.field_errors as Record<string, string> | null, data.request_id as string | null))
      }
      const form = new FormData()
      form.append('file', file, file.name)
      xhr.send(form)
    })
  },

  // ---------- assignments and assessment ----------
  assign(ticket: Pick<Ticket, 'id' | 'version'>, workerIds: string[], leadWorkerId: string, channel: Channel): Promise<Ticket> {
    return request('POST', `/tickets/${ticket.id}/assignments`, { body: { workerIds, leadWorkerId, channel, expectedVersion: ticket.version } })
  },
  recordAcceptance(ticket: Pick<Ticket, 'id' | 'version'>, assignmentId: string, via: 'call' | 'in_person' | 'sms'): Promise<Ticket> {
    return request('POST', `/tickets/${ticket.id}/assignments/${assignmentId}/accept`, { body: { via, expectedVersion: ticket.version } })
  },
  releaseAssignment(ticket: Pick<Ticket, 'id' | 'version'>, assignmentId: string, reason: string): Promise<Ticket> {
    return request('POST', `/tickets/${ticket.id}/assignments/${assignmentId}/release`, { body: { reason, expectedVersion: ticket.version } })
  },
  recordAssessment(ticket: Pick<Ticket, 'id' | 'version'>, assessments: Assessment[], workerId: string, via: Channel | 'in_person', note: string): Promise<Ticket> {
    return request('POST', `/tickets/${ticket.id}/assessments`, { body: { assessments, workerId, via, note, expectedVersion: ticket.version } })
  },

  // ---------- costs ----------
  createProposal(ticket: Pick<Ticket, 'id' | 'version'>, lines: Proposal['lines'], requestedDate: string, remedy: string): Promise<Ticket> {
    return request('POST', `/tickets/${ticket.id}/proposals`, { body: { lines, requestedDate, remedy, expectedVersion: ticket.version } })
  },
  decide(proposal: Pick<Proposal, 'id' | 'version'>, kind: DecisionKind, opts: { ceilingPaise?: number; conditions?: string; reason?: string; reviewDate?: string }): Promise<Ticket> {
    return request('POST', `/proposals/${proposal.id}/decisions`, { body: { kind, proposalVersion: proposal.version, ...opts } })
  },

  // ---------- workers ----------
  listWorkers(params: { trade?: string; active?: boolean } = {}): Promise<Worker[]> {
    return request('GET', `/workers${qs(params)}`)
  },
  createWorker(w: { name: string; phone: string; trades: string[]; area: string; language: string; mode: Worker['mode']; kind: Worker['kind'] }): Promise<Worker> {
    return request('POST', '/workers', { body: w })
  },
  updateWorker(w: Pick<Worker, 'id' | 'version'>, patch: Partial<{ name: string; phone: string; trades: string[]; area: string; language: string; mode: Worker['mode']; kind: Worker['kind']; active: boolean }>): Promise<Worker> {
    return request('PATCH', `/workers/${w.id}`, { body: { ...patch, expectedVersion: w.version } })
  },
  importWorkers(rows: { name: string; phone: string; trades: string[]; area: string; language: string; mode: Worker['mode']; kind: Worker['kind'] }[]): Promise<{ name: string; phone: string; status: 'created' | 'exists' | 'invalid'; message: string | null }[]> {
    return request('POST', '/workers/import', { body: rows })
  },

  // ---------- admin: users ----------
  listUsers(params: { q?: string; role?: string; active?: boolean; page?: number; pageSize?: number } = {}): Promise<Page<AdminUser>> {
    return request('GET', `/admin/users${qs({ ...params, pageSize: params.pageSize ?? 25 })}`)
  },
  createUser(body: { employeeId: string; name: string; role: AdminUser['role']; email?: string }): Promise<Credential> {
    return request('POST', '/admin/users', { body })
  },
  updateUser(u: Pick<AdminUser, 'id' | 'version'>, patch: { name?: string; email?: string; role?: AdminUser['role']; active?: boolean; reason?: string }): Promise<AdminUser> {
    return request('PATCH', `/admin/users/${u.id}`, { body: { ...patch, expectedVersion: u.version } })
  },
  resetUserPassword(u: Pick<AdminUser, 'id'>, resetMfa: boolean): Promise<Credential> {
    return request('POST', `/admin/users/${u.id}/reset-password`, { body: { resetMfa } })
  },
  previewImport(file: File): Promise<{ toCreate: number; alreadyExist: string[] }> {
    const form = new FormData()
    form.append('file', file, file.name)
    return request('POST', '/admin/users/import?dryRun=true', { form })
  },
  async importUsers(file: File): Promise<{ blob: Blob; filename: string; created: number; existing: number }> {
    const form = new FormData()
    form.append('file', file, file.name)
    const r = await requestBlob('POST', '/admin/users/import', { form, accept: 'text/csv' })
    return { blob: r.blob, filename: r.filename, created: Number(r.headers.get('x-pcms-created') ?? 0), existing: Number(r.headers.get('x-pcms-existing') ?? 0) }
  },
  importTemplate(): Promise<{ blob: Blob; filename: string }> {
    return requestBlob('GET', '/admin/users/import/template', { accept: 'text/csv' })
  },

  // ---------- messages needing a person ----------
  listFailedNotifications(): Promise<FailedNotification[]> {
    return request('GET', '/admin/notifications')
  },
  actOnNotification(id: number, op: 'retry' | 'dismiss'): Promise<void> {
    return request('POST', `/admin/notifications/${id}/${op}`)
  },

  // ---------- reports and export ----------
  report(params: { days?: number; building?: string; category?: string } = {}): Promise<Report> {
    return request('GET', `/reports${qs({ days: params.days, building: params.building, category: params.category })}`)
  },
  /** Audited on the server, so the download itself is recorded. */
  exportTicketsCsv(days = 90): Promise<{ blob: Blob; filename: string }> {
    return requestBlob('GET', `/reports/tickets.csv${qs({ days })}`, { accept: 'text/csv' })
  },

  // ---------- audit ----------
  /** Newest first. Pass beforeId from the last row to page backwards through history. */
  auditLog(params: { action?: string; entityId?: string; beforeId?: number; limit?: number } = {}): Promise<AuditEvent[]> {
    return request('GET', `/admin/audit${qs({ action: params.action, entityId: params.entityId, beforeId: params.beforeId, limit: params.limit ?? 100 })}`)
  },

  // ---------- catalogs ----------
  editCategory(code: string, patch: { nameEn?: string; nameHi?: string; subtypesEn?: string[]; subtypesHi?: string[]; active?: boolean }): Promise<void> {
    return request('PATCH', `/admin/categories/${encodeURIComponent(code)}`, { body: patch })
  },
  editBuilding(code: string, patch: { nameEn?: string; nameHi?: string; floors?: string[]; active?: boolean }): Promise<void> {
    return request('PATCH', `/admin/buildings/${encodeURIComponent(code)}`, { body: patch })
  },
}

export interface FailedNotification {
  id: number
  channel: string
  template: string
  attempts: number
  lastError: string | null
  createdAt: string
  ticketId: string | null
  ticketToken: string | null
  recipient: string
}

/** Clear everything this device holds for the signed-in person. */
export function clearLocalData() {
  setCsrf(null)
  resetCatalogs()
  localStorage.removeItem(DRAFTS_KEY)
  // Older builds kept a local demo database; remove it if present.
  localStorage.removeItem('pcms.db.v1')
  sessionStorage.clear()
}

export function formatPaise(p: number): string {
  return '₹' + (p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/** Parse a rupee amount typed by a person into integer paise, without float drift. */
export function parseRupees(input: string): number | null {
  const s = input.replace(/[,\s₹]/g, '')
  if (!/^\d{1,9}(\.\d{0,2})?$/.test(s)) return null
  const [whole, frac = ''] = s.split('.')
  return Number(whole) * 100 + Number((frac + '00').slice(0, 2))
}

export function labelStatus(s: Status): string {
  const map: Record<Status, string> = {
    Submitted: 'Submitted', Triaged: 'Triaged', Assigned: 'Assigned', InProgress: 'In progress',
    OnHold: 'On hold', AwaitingApproval: 'Awaiting approval', Resolved: 'Resolved', Closed: 'Closed',
    Cancelled: 'Cancelled', Rejected: 'Rejected', Duplicate: 'Duplicate',
  }
  return map[s]
}

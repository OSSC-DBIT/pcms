import { useCallback, useEffect, useRef, useState } from 'react'
import { Download, KeyRound, Upload, UserPlus } from 'lucide-react'
import { useAuth } from '../../App'
import { ActionDialog } from '../../components/ActionDialog'
import { Alert, Badge, Button, Card, Dialog, Field, Input, PageHeader, Select, Skeleton, Stack, Tabs, errorMessage } from '../../components/ui'
import { api } from '../../lib/api'
import { buildings, categories, loadCatalogs } from '../../lib/catalog'
import { request, saveBlob } from '../../lib/http'
import type { AdminUser, Credential, Role } from '../../lib/types'

const ROLE: Record<Role, string> = { faculty: 'Faculty', facility_manager: 'Facility manager', management: 'Institute management', ossc: 'Super admin (OSSC)' }
const IST: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }

export default function Admin() {
  const { can } = useAuth()
  const tabs = [
    ...(can('admin.users') ? [{ value: 'users' as const, label: 'People' }] : []),
    { value: 'types' as const, label: 'Types' },
    { value: 'places' as const, label: 'Places' },
  ]
  const [tab, setTab] = useState(tabs[0].value)
  return (
    <Stack>
      <PageHeader title="Administration" />
      <Tabs label="Admin section" value={tab} onChange={setTab} tabs={tabs} />
      {tab === 'users' && <People />}
      {tab === 'types' && <Types />}
      {tab === 'places' && <Places />}
    </Stack>
  )
}

function CredentialDialog({ cred, onClose }: { cred: Credential | null; onClose: () => void }) {
  const [copied, setCopied] = useState(false)
  return (
    <Dialog open={!!cred} onClose={() => { setCopied(false); onClose() }} title="Temporary password"
      footer={<Button onClick={() => { setCopied(false); onClose() }}>Done</Button>}>
      {cred && (
        <Stack>
          <p className="text-[14px]">For <b>{cred.user.name}</b> ({cred.user.employeeId}). Shown only now. They must change it at first sign-in.</p>
          <p className="token select-all rounded-md bg-subtle px-4 py-3 text-center text-[24px] font-bold">{cred.temporaryPassword}</p>
          <p className="text-[13px] text-muted">Expires {new Date(cred.expiresAt).toLocaleString('en-IN', IST)}. Give it to the person directly, not in a group chat.</p>
          <Button variant="secondary" onClick={async () => { await navigator.clipboard.writeText(cred.temporaryPassword); setCopied(true) }}>{copied ? 'Copied' : 'Copy'}</Button>
        </Stack>
      )}
    </Dialog>
  )
}

function People() {
  const { user: me } = useAuth()
  const [q, setQ] = useState('')
  const [users, setUsers] = useState<AdminUser[] | null>(null)
  const [total, setTotal] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [cred, setCred] = useState<Credential | null>(null)
  const [adding, setAdding] = useState(false)
  const [importing, setImporting] = useState(false)
  const [action, setAction] = useState<{ user: AdminUser; kind: 'suspend' | 'reactivate' | 'role' | 'reset' } | null>(null)

  const load = useCallback(async (query: string) => {
    try { const p = await api.listUsers({ q: query || undefined }); setUsers(p.items); setTotal(p.total) } catch (e) { setError(errorMessage(e)); setUsers([]) }
  }, [])
  useEffect(() => { const id = setTimeout(() => void load(q), 250); return () => clearTimeout(id) }, [q, load])
  const replace = (u: AdminUser) => setUsers((us) => us?.map((x) => x.id === u.id ? u : x) ?? null)

  return (
    <Stack>
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => setImporting(true)}><Upload size={17} /> Import CSV</Button>
        <Button variant="secondary" onClick={() => setAdding(true)}><UserPlus size={17} /> Add person</Button>
      </div>
      <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by employee ID or name" aria-label="Search people" />
      <p className="text-[13px] text-muted">{total} account(s)</p>
      {error && <Alert tone="bad">{error}</Alert>}
      {users === null ? <Skeleton className="h-40" /> : (
        <div className="overflow-hidden rounded-lg border border-line bg-surface">
          {users.map((u) => (
            <div key={u.id} className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3 last:border-b-0">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[15px] font-medium">{u.name}</p>
                <p className="token text-[13px] text-muted">{u.employeeId} · {ROLE[u.role]}</p>
              </div>
              <Badge tone={!u.active ? 'bad' : u.mustChangePassword ? 'warn' : 'ok'}>{!u.active ? 'Suspended' : u.mustChangePassword ? 'Not activated' : 'Active'}</Badge>
              {u.id !== me?.id && (
                <div className="flex flex-wrap gap-1">
                  <Button size="sm" variant="ghost" onClick={() => setAction({ user: u, kind: 'reset' })}><KeyRound size={15} /> Reset</Button>
                  <Button size="sm" variant="ghost" onClick={() => setAction({ user: u, kind: 'role' })}>Role</Button>
                  <Button size="sm" variant={u.active ? 'danger' : 'secondary'} onClick={() => setAction({ user: u, kind: u.active ? 'suspend' : 'reactivate' })}>{u.active ? 'Suspend' : 'Reactivate'}</Button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      <AddPerson open={adding} onClose={() => setAdding(false)} onCreated={(c) => { setCred(c); void load(q) }} />
      <ImportCsv open={importing} onClose={() => { setImporting(false); void load(q) }} />
      <CredentialDialog cred={cred} onClose={() => setCred(null)} />
      {action?.kind === 'reset' && (
        <ActionDialog open title={`Reset password for ${action.user.employeeId}`} confirmLabel="Issue new password"
          description="Their current sessions end now. A new temporary password is shown once."
          fields={action.user.totpEnabled ? [{ name: 'mfa', label: 'Also reset authenticator app?', type: 'select', required: true, options: [{ value: 'no', label: 'No' }, { value: 'yes', label: 'Yes, they lost their phone (identity checked)' }] }] : []}
          onClose={() => setAction(null)}
          onSubmit={async (v) => { const c = await api.resetUserPassword(action.user, v.mfa === 'yes'); replace(c.user); setCred(c) }} />
      )}
      {(action?.kind === 'suspend' || action?.kind === 'reactivate') && (
        <ActionDialog open title={`${action.kind === 'suspend' ? 'Suspend' : 'Reactivate'} ${action.user.employeeId}`} danger={action.kind === 'suspend'}
          confirmLabel={action.kind === 'suspend' ? 'Suspend' : 'Reactivate'} fields={[{ name: 'reason', label: 'Reason', type: 'textarea', required: true }]}
          onClose={() => setAction(null)}
          onSubmit={async (v) => replace(await api.updateUser(action.user, { active: action.kind === 'reactivate', reason: v.reason }))} />
      )}
      {action?.kind === 'role' && (
        <ActionDialog open title={`Change role of ${action.user.employeeId}`} confirmLabel="Change role" description="Their sessions end and they sign in again."
          fields={[{ name: 'role', label: 'New role', type: 'select', required: true, options: (Object.keys(ROLE) as Role[]).filter((r) => r !== action.user.role).map((r) => ({ value: r, label: ROLE[r] })) },
            { name: 'reason', label: 'Reason', type: 'textarea', required: true }]}
          onClose={() => setAction(null)}
          onSubmit={async (v) => replace(await api.updateUser(action.user, { role: v.role as Role, reason: v.reason }))} />
      )}
    </Stack>
  )
}

function AddPerson({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (c: Credential) => void }) {
  const [employeeId, setEmployeeId] = useState('')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<Role>('faculty')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const close = () => { setEmployeeId(''); setName(''); setEmail(''); setRole('faculty'); setError(null); onClose() }
  async function save(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setError(null)
    try { onCreated(await api.createUser({ employeeId, name, role, email: email.trim() || undefined })); close() }
    catch (err) { setError(errorMessage(err)) } finally { setBusy(false) }
  }
  return (
    <Dialog open={open} onClose={close} title="Add person">
      <form onSubmit={save} className="space-y-4">
        <Field label="Employee ID">{(id) => <Input id={id} className="token" value={employeeId} onChange={(e) => setEmployeeId(e.target.value.toUpperCase())} maxLength={32} required />}</Field>
        <Field label="Full name">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required />}</Field>
        <Field label="Email" optional hint="For report receipts">{(id, d) => <Input id={id} aria-describedby={d} type="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={254} />}</Field>
        <Field label="Role">{(id) => <Select id={id} value={role} onChange={(e) => setRole(e.target.value as Role)}>{(Object.keys(ROLE) as Role[]).map((r) => <option key={r} value={r}>{ROLE[r]}</option>)}</Select>}</Field>
        {error && <Alert tone="bad">{error}</Alert>}
        <div className="flex justify-end gap-2"><Button variant="secondary" onClick={close}>Cancel</Button><Button type="submit" loading={busy}>Create</Button></div>
      </form>
    </Dialog>
  )
}

function ImportCsv({ open, onClose }: { open: boolean; onClose: () => void }) {
  const input = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<{ toCreate: number; alreadyExist: string[] } | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const close = () => { setFile(null); setPreview(null); setDone(null); setError(null); onClose() }

  async function choose(f?: File) {
    if (input.current) input.current.value = ''
    if (!f) return
    setFile(f); setPreview(null); setDone(null); setError(null); setBusy(true)
    try { setPreview(await api.previewImport(f)) } catch (e) { setError(errorMessage(e)) } finally { setBusy(false) }
  }
  async function run() {
    if (!file) return
    setBusy(true); setError(null)
    try {
      const r = await api.importUsers(file)
      saveBlob(r.blob, r.filename)
      setDone(`${r.created} account(s) created${r.existing ? `, ${r.existing} already existed` : ''}. "${r.filename}" was downloaded with the temporary passwords.`)
      setPreview(null); setFile(null)
    } catch (e) { setError(errorMessage(e)) } finally { setBusy(false) }
  }

  return (
    <Dialog open={open} onClose={close} title="Import people from CSV">
      <Stack>
        <p className="text-[14px]">Columns: <span className="token">employee_id, name</span>, and optionally <span className="token">role, email</span>. Role is faculty, facility_manager or management. Up to 1000 per file; if any line is wrong nothing is imported.</p>
        <Alert tone="warn">The downloaded file contains temporary passwords. Hand each one to the person directly and delete the file afterwards.</Alert>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={async () => { try { const t = await api.importTemplate(); saveBlob(t.blob, t.filename) } catch (e) { setError(errorMessage(e)) } }}><Download size={16} /> Template</Button>
          <Button onClick={() => input.current?.click()}><Upload size={16} /> Choose CSV</Button>
        </div>
        <input ref={input} type="file" accept=".csv,text/csv" hidden onChange={(e) => void choose(e.target.files?.[0])} />
        {busy && !preview && <Skeleton className="h-12" />}
        {file && preview && (
          <Card>
            <p className="text-[14.5px] font-medium">{file.name}</p>
            <p className="mt-1 text-[14px]">{preview.toCreate} new account(s).</p>
            {preview.alreadyExist.length > 0 && <p className="mt-1 text-[13px] text-muted">Already exist (unchanged): {preview.alreadyExist.join(', ')}</p>}
            <Button className="mt-3" loading={busy} disabled={!preview.toCreate} onClick={run}>Create and download passwords</Button>
          </Card>
        )}
        {done && <Alert tone="ok">{done}</Alert>}
        {error && <Alert tone="bad"><span className="whitespace-pre-line">{error}</span></Alert>}
      </Stack>
    </Dialog>
  )
}

function Types() {
  const { can } = useAuth()
  const [adding, setAdding] = useState(false)
  const [, refresh] = useState(0)
  return (
    <Stack>
      <p className="text-[14px] text-muted">The letter starts every token of that type (C26-0001 for Carpentry). Letters are never reused.</p>
      {can('admin.catalogs') && <Button className="self-start" onClick={() => setAdding(true)}>Add type</Button>}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {categories().map((c) => (
          <Card key={c.code}>
            <div className="flex items-center gap-3">
              <span className="token flex h-10 w-10 items-center justify-center rounded-md bg-accent-soft text-[18px] font-bold text-accent">{c.letter}</span>
              <div><p className="text-[15px] font-semibold">{c.nameEn}</p><p className="text-[13px] text-muted">{c.nameHi}</p></div>
            </div>
            <p className="mt-2 text-[13px] text-muted">{c.subtypesEn.join(', ')}</p>
          </Card>
        ))}
      </div>
      {adding && (
        <ActionDialog open title="Add type" confirmLabel="Add"
          fields={[{ name: 'nameEn', label: 'Name (English)', required: true }, { name: 'nameHi', label: 'Name (Hindi)', required: true },
            { name: 'letter', label: 'Token letter (A to Z, unused)', required: true }, { name: 'parts', label: 'Parts, comma separated', hint: 'Other is added automatically' }]}
          onClose={() => setAdding(false)}
          onSubmit={async (v) => {
            const parts = (v.parts ?? '').split(',').map((s) => s.trim()).filter(Boolean)
            const subtypes = [...parts.filter((p) => p.toLowerCase() !== 'other'), 'Other']
            await request('POST', '/admin/categories', { body: {
              code: v.nameEn.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'type',
              letter: v.letter.toUpperCase(), nameEn: v.nameEn, nameHi: v.nameHi, subtypesEn: subtypes, subtypesHi: subtypes } })
            await loadCatalogs(true); refresh((n) => n + 1)
          }} />
      )}
    </Stack>
  )
}

function Places() {
  const { can } = useAuth()
  const [adding, setAdding] = useState(false)
  const [, refresh] = useState(0)
  return (
    <Stack>
      <p className="text-[14px] text-muted">Buildings and floors people choose from on the report form.</p>
      {can('admin.locations') && <Button className="self-start" onClick={() => setAdding(true)}>Add place</Button>}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {buildings().map((b) => (
          <Card key={b.code}>
            <p className="text-[15px] font-semibold">{b.nameEn}</p>
            <p className="text-[13px] text-muted">{b.nameHi}</p>
            <p className="mt-2 text-[13px]">Floors: {b.floors.join(', ')}</p>
          </Card>
        ))}
      </div>
      {adding && (
        <ActionDialog open title="Add place" confirmLabel="Add"
          fields={[{ name: 'nameEn', label: 'Name (English)', required: true }, { name: 'nameHi', label: 'Name (Hindi)', required: true },
            { name: 'code', label: 'Short code', required: true, placeholder: 'e.g. INC' }, { name: 'floors', label: 'Floors, comma separated', required: true, placeholder: 'Ground, 1, 2' }]}
          onClose={() => setAdding(false)}
          onSubmit={async (v) => {
            await request('POST', '/admin/buildings', { body: { code: v.code.toUpperCase(), nameEn: v.nameEn, nameHi: v.nameHi,
              floors: v.floors.split(',').map((s) => s.trim()).filter(Boolean) } })
            await loadCatalogs(true); refresh((n) => n + 1)
          }} />
      )}
    </Stack>
  )
}

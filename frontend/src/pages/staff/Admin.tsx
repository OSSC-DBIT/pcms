import { useCallback, useEffect, useRef, useState } from 'react'
import { Download, FileSpreadsheet, KeyRound, Pencil, Power, RefreshCw, Upload, UserPlus } from 'lucide-react'
import { useAuth } from '../../App'
import { ActionDialog } from '../../components/ActionDialog'
import { Pager } from '../../components/Pager'
import { Alert, Badge, Button, Card, Dialog, EmptyState, Field, Input, PageHeader, Select, Skeleton, Stack, Tabs, errorMessage } from '../../components/ui'
import { api } from '../../lib/api'
import { allBuildings, allCategories, loadAllCatalogs, loadCatalogs } from '../../lib/catalog'
import { request, saveBlob } from '../../lib/http'
import type { AdminUser, Credential, Role } from '../../lib/types'

const ROLE: Record<Role, string> = { faculty: 'Faculty', facility_manager: 'Facility manager', management: 'Institute management', ossc: 'Super admin (OSSC)' }
const IST: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }

/** A random initial password. The admin can see and replace it before creating the account. */
function suggestPassword(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12))
  const token = Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 14)
  return `Tmp-${token}-26`
}

export default function Admin() {
  const { can } = useAuth()
  const tabs = [
    ...(can('admin.users') ? [{ value: 'users' as const, label: 'People' }] : []),
    { value: 'types' as const, label: 'Types' },
    { value: 'places' as const, label: 'Places' },
  ]
  const [tab, setTab] = useState(tabs[0].value)
  const [ready, setReady] = useState(false)
  // The admin screens need retired rows too, so they hold their own copy of the list.
  useEffect(() => { void loadAllCatalogs().then(() => setReady(true)).catch(() => setReady(true)) }, [])
  return (
    <Stack>
      <PageHeader title="Administration" />
      <Tabs label="Admin section" value={tab} onChange={setTab} tabs={tabs} />
      {tab === 'users' && <People />}
      {tab === 'types' && <Types ready={ready} />}
      {tab === 'places' && <Places ready={ready} />}
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
          <p className="text-[14px]">For <b>{cred.user.name}</b> ({cred.user.email}). They must change it at first sign-in. It stays downloadable by Team OSSC until they do.</p>
          <p className="token select-all rounded-md bg-subtle px-4 py-3 text-center text-[24px] font-bold">{cred.temporaryPassword}</p>
          <p className="text-[13px] text-muted">{cred.expiresAt ? `Expires ${new Date(cred.expiresAt).toLocaleString('en-IN', IST)}. ` : ''}Give it to the person directly, not in a group chat.</p>
          <Button variant="secondary" onClick={async () => { await navigator.clipboard.writeText(cred.temporaryPassword); setCopied(true) }}>{copied ? 'Copied' : 'Copy'}</Button>
        </Stack>
      )}
    </Dialog>
  )
}

function People() {
  const { user: me } = useAuth()
  const [q, setQ] = useState('')
  const [role, setRole] = useState<Role | ''>('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)
  const [users, setUsers] = useState<AdminUser[] | null>(null)
  const [total, setTotal] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [cred, setCred] = useState<Credential | null>(null)
  const [adding, setAdding] = useState(false)
  const [importing, setImporting] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [action, setAction] = useState<{ user: AdminUser; kind: 'suspend' | 'reactivate' | 'role' | 'reset' } | null>(null)

  const load = useCallback(async (query: string, roleFilter: Role | '', atPage: number, size: number) => {
    try {
      const p = await api.listUsers({ q: query || undefined, role: roleFilter || undefined, page: atPage, pageSize: size })
      setUsers(p.items); setTotal(p.total); setPage(p.page)
    } catch (e) { setError(errorMessage(e)); setUsers([]) }
  }, [])
  useEffect(() => { const id = setTimeout(() => void load(q, role, page, pageSize), 250); return () => clearTimeout(id) }, [q, role, page, pageSize, load])
  const replace = (u: AdminUser) => setUsers((us) => us?.map((x) => x.id === u.id ? u : x) ?? null)

  return (
    <Stack>
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => setAdding(true)}><UserPlus size={17} /> Add person</Button>
        <Button variant="secondary" onClick={() => setImporting(true)}><Upload size={17} /> Import file</Button>
        <Button variant="secondary" onClick={() => setExporting(true)}><FileSpreadsheet size={17} /> Credentials file</Button>
      </div>
      <div className="flex flex-wrap gap-3">
        <div className="w-full sm:w-64">
          <Input value={q} onChange={(e) => { setQ(e.target.value); setPage(1) }} placeholder="Search by email or name" aria-label="Search people" />
        </div>
        <div className="w-48">
          <Select aria-label="Filter by role" value={role} onChange={(e) => { setRole(e.target.value as Role | ''); setPage(1) }}>
            <option value="">All roles</option>{(Object.keys(ROLE) as Role[]).map((r) => <option key={r} value={r}>{ROLE[r]}</option>)}
          </Select>
        </div>
      </div>
      {error && <Alert tone="bad">{error}</Alert>}
      {users === null ? <Skeleton className="h-40" /> : (
        <>
          {users.length === 0 && !q && !role && <EmptyState title="No accounts yet" body="Add a person or import an Excel or CSV file to get started." />}
          {users.length > 0 && (
            <div className="overflow-hidden rounded-lg border border-line bg-surface">
              {users.map((u) => (
                <div key={u.id} className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3 last:border-b-0">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[15px] font-medium">{u.name}</p>
                    <p className="token text-[13px] text-muted">{u.email} · {ROLE[u.role]}</p>
                    <p className="mt-0.5 text-[12px] text-muted">
                      {u.mustChangePassword
                        ? (u.tempPasswordExpiresAt ? `Temporary password expires ${new Date(u.tempPasswordExpiresAt).toLocaleString('en-IN', IST)}` : 'No temporary password on file')
                        : (u.passwordChangedAt ? `Password changed ${new Date(u.passwordChangedAt).toLocaleString('en-IN', IST)}` : 'Password set')}
                    </p>
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
          <Pager page={page} pageCount={Math.max(1, Math.ceil(total / pageSize))} total={total} pageSize={pageSize}
            onPage={setPage} onPageSize={(n) => { setPageSize(n); setPage(1) }} />
        </>
      )}
      <AddPerson open={adding} onClose={() => setAdding(false)} onCreated={(c) => { setCred(c); void load(q, role, 1, pageSize) }} />
      <ImportCsv open={importing} onClose={() => { setImporting(false); void load(q, role, page, pageSize) }} />
      <CredentialDialog cred={cred} onClose={() => setCred(null)} />
      {action?.kind === 'reset' && (
        <ActionDialog open title={`Reset password for ${action.user.email}`} confirmLabel="Issue new password"
          description="Their current sessions end now. The temporary password stays downloadable until they set their own."
          fields={[
            { name: 'password', label: 'New temporary password', hint: 'Leave blank to generate a strong one. At least 10 characters.' },
            ...(action.user.totpEnabled ? [{ name: 'mfa', label: 'Also reset authenticator app?', type: 'select' as const, required: true, options: [{ value: 'no', label: 'No' }, { value: 'yes', label: 'Yes, they lost their phone (identity checked)' }] }] : []),
          ]}
          onClose={() => setAction(null)}
          onSubmit={async (v) => { const c = await api.resetUserPassword(action.user, v.mfa === 'yes', v.password); replace(c.user); setCred(c) }} />
      )}
      {(action?.kind === 'suspend' || action?.kind === 'reactivate') && (
        <ActionDialog open title={`${action.kind === 'suspend' ? 'Suspend' : 'Reactivate'} ${action.user.email}`} danger={action.kind === 'suspend'}
          confirmLabel={action.kind === 'suspend' ? 'Suspend' : 'Reactivate'} fields={[{ name: 'reason', label: 'Reason', type: 'textarea', required: true }]}
          onClose={() => setAction(null)}
          onSubmit={async (v) => replace(await api.updateUser(action.user, { active: action.kind === 'reactivate', reason: v.reason }))} />
      )}
      {action?.kind === 'role' && (
        <ActionDialog open title={`Change role of ${action.user.email}`} confirmLabel="Change role" description="Their sessions end and they sign in again."
          fields={[{ name: 'role', label: 'New role', type: 'select', required: true, options: (Object.keys(ROLE) as Role[]).filter((r) => r !== action.user.role).map((r) => ({ value: r, label: ROLE[r] })) },
            { name: 'reason', label: 'Reason', type: 'textarea', required: true }]}
          onClose={() => setAction(null)}
          onSubmit={async (v) => replace(await api.updateUser(action.user, { role: v.role as Role, reason: v.reason }))} />
      )}
      {exporting && (
        <ActionDialog open title="Download credentials file" confirmLabel="Download"
          description={<>This Excel file contains temporary passwords that are still valid. It uses the search and role filters on this screen. The download is audited and requires your own password.</>}
          initial={{ scope: 'pending' }}
          fields={[
            { name: 'password', label: 'Your password', type: 'password', required: true },
            { name: 'scope', label: 'Which accounts', type: 'select', required: true, options: [
              { value: 'pending', label: 'Only not activated (has a temporary password)' },
              { value: 'all', label: 'All accounts' },
              { value: 'active', label: 'Only activated' },
            ] },
          ]}
          onClose={() => setExporting(false)}
          onSubmit={async (v) => {
            const pending = v.scope === 'pending' ? true : v.scope === 'active' ? false : undefined
            const r = await api.credentialsExport(v.password, { q: q || undefined, role: role || undefined, pending })
            saveBlob(r.blob, r.filename)
          }} />
      )}
    </Stack>
  )
}

function AddPerson({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (c: Credential) => void }) {
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [password, setPassword] = useState(() => suggestPassword())
  const [role, setRole] = useState<Role>('faculty')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const close = () => { setEmail(''); setName(''); setPassword(suggestPassword()); setRole('faculty'); setError(null); onClose() }
  async function save(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setError(null)
    try { onCreated(await api.createUser({ email: email.trim(), name, role, password })); close() }
    catch (err) { setError(errorMessage(err)) } finally { setBusy(false) }
  }
  return (
    <Dialog open={open} onClose={close} title="Add person">
      <form onSubmit={save} className="space-y-4">
        <Field label="College email">{(id) => <Input id={id} type="email" className="token" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" maxLength={254} required />}</Field>
        <Field label="Full name">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" maxLength={120} required />}</Field>
        <Field label="Temporary password" hint="They must change it at first sign-in. Share it directly with this person.">
          {(id, d) => (
            <div className="flex gap-2">
              <Input id={id} aria-describedby={d} className="token flex-1" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" minLength={10} maxLength={128} required />
              <Button type="button" variant="secondary" onClick={() => setPassword(suggestPassword())}><RefreshCw size={15} /> Suggest</Button>
            </div>
          )}
        </Field>
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
    <Dialog open={open} onClose={close} title="Import people from Excel or CSV">
      <Stack>
        <p className="text-[14px]">Columns: <span className="token">email, name, role, password</span>. Role is faculty, facility_manager or management, and defaults to faculty. Up to 1000 per file. If any line is wrong nothing is imported. OSSC accounts are added one at a time.</p>
        <Alert tone="warn">The downloaded Excel file contains temporary passwords. Hand each one to the person directly and delete the file afterwards. You can download it again until they set their own password.</Alert>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={async () => { try { const t = await api.importTemplate(); saveBlob(t.blob, t.filename) } catch (e) { setError(errorMessage(e)) } }}><Download size={16} /> Template</Button>
          <Button onClick={() => input.current?.click()}><Upload size={16} /> Choose file</Button>
        </div>
        <input ref={input} type="file" accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv" hidden onChange={(e) => void choose(e.target.files?.[0])} />
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

function Types({ ready }: { ready: boolean }) {
  const { can } = useAuth()
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [toggling, setToggling] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const manage = can('admin.catalogs')
  const list = allCategories()

  async function refresh() {
    await loadCatalogs(true)
    await loadAllCatalogs(true)
  }

  return (
    <Stack>
      <p className="text-[14px] text-muted">The letter starts every token of that type (C26-0001 for Carpentry). Letters are never reused, even if a type is retired.</p>
      {notice && <Alert tone="ok">{notice}</Alert>}
      {error && <Alert tone="bad">{error}</Alert>}
      {manage && <Button className="self-start" onClick={() => setAdding(true)}>Add type</Button>}
      {!ready ? <Skeleton className="h-40" /> : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {list.map((c) => (
            <Card key={c.code}>
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-3">
                  <span className={`token flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-[18px] font-bold ${c.active ? 'bg-accent-soft text-accent' : 'bg-subtle text-muted'}`}>{c.letter}</span>
                  <div className="min-w-0">
                    <p className="truncate text-[15px] font-semibold">{c.nameEn}</p>
                    <p className="truncate text-[13px] text-muted">{c.nameHi}</p>
                  </div>
                </div>
                {!c.active && <Badge>Retired</Badge>}
              </div>
              <p className="mt-2 text-[13px] text-muted">{c.subtypesEn.join(', ')}</p>
              {manage && (
                <div className="mt-2 flex flex-wrap gap-1">
                  <Button size="sm" variant="ghost" className="-ml-3" onClick={() => setEditing(c.code)}><Pencil size={15} /> Edit</Button>
                  <Button size="sm" variant="ghost" onClick={() => setToggling(c.code)}><Power size={15} /> {c.active ? 'Retire' : 'Restore'}</Button>
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
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
            await refresh()
          }} />
      )}
      {editing && <EditCategoryDialog code={editing} onClose={() => setEditing(null)}
        onSaved={async (msg) => { setEditing(null); setNotice(msg); await refresh() }}
        onError={(msg) => { setEditing(null); setError(msg) }} />}
      {toggling && <ToggleCatalogDialog code={toggling} kind="type" onClose={() => setToggling(null)}
        onSaved={async (msg) => { setToggling(null); setNotice(msg); await refresh() }}
        onError={(msg) => { setToggling(null); setError(msg) }} />}
    </Stack>
  )
}

/** Rename a type, edit its subtypes, or retire it. The token letter is fixed for good. */
function EditCategoryDialog({ code, onClose, onSaved, onError }: { code: string; onClose: () => void; onSaved: (m: string) => void; onError: (m: string) => void }) {
  const c = allCategories().find((x) => x.code === code)
  const [nameEn, setNameEn] = useState(c?.nameEn ?? '')
  const [nameHi, setNameHi] = useState(c?.nameHi ?? '')
  const [parts, setParts] = useState((c?.subtypesEn ?? []).join(', '))
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const subtypes = parts.split(',').map((s) => s.trim()).filter(Boolean)

  async function save(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setError(null)
    try {
      await api.editCategory(code, { nameEn: nameEn.trim(), nameHi: nameHi.trim(), subtypesEn: subtypes, subtypesHi: subtypes })
      onSaved(`${nameEn.trim()} updated.`)
    } catch (err) { onError(errorMessage(err)) } finally { setBusy(false) }
  }

  if (!c) return null
  return (
    <Dialog open onClose={onClose} title={`Edit type: ${c.nameEn}`}>
      <form onSubmit={save} className="space-y-4">
        <p className="text-[13px] text-muted">Token letter {c.letter} stays the same for every ticket of this type.</p>
        <Field label="Name (English)">{(id) => <Input id={id} value={nameEn} onChange={(e) => setNameEn(e.target.value)} maxLength={80} required />}</Field>
        <Field label="Name (Hindi)">{(id) => <Input id={id} value={nameHi} onChange={(e) => setNameHi(e.target.value)} maxLength={80} required />}</Field>
        <Field label="Parts" hint="Comma separated. The reporter picks one of these.">
          {(id, d) => <Input id={id} aria-describedby={d} value={parts} onChange={(e) => setParts(e.target.value)} maxLength={400} />}
        </Field>
        {error && <Alert tone="bad">{error}</Alert>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={busy} disabled={!nameEn.trim() || !nameHi.trim()}>Save</Button>
        </div>
      </form>
    </Dialog>
  )
}

function ToggleCatalogDialog({ code, kind, onClose, onSaved, onError }: {
  code: string; kind: 'type' | 'place'; onClose: () => void; onSaved: (m: string) => void; onError: (m: string) => void
}) {
  const isType = kind === 'type'
  const current = isType ? allCategories().find((x) => x.code === code) : allBuildings().find((x) => x.code === code)
  const active = current?.active ?? true
  const [busy, setBusy] = useState(false)

  async function go() {
    setBusy(true)
    try {
      if (isType) await api.editCategory(code, { active: !active })
      else await api.editBuilding(code, { active: !active })
      onSaved(`${current?.nameEn ?? code} ${active ? 'retired' : 'restored'}.`)
    } catch (err) { onError(errorMessage(err)) } finally { setBusy(false) }
  }

  if (!current) return null
  return (
    <Dialog open onClose={onClose} title={active ? `Retire this ${kind}` : `Restore this ${kind}`}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} variant={active ? 'danger' : 'primary'} onClick={() => void go()}>{active ? 'Retire' : 'Restore'}</Button></>}>
      <p className="text-[14px]">
        {active
          ? `People will no longer be able to choose ${current.nameEn} on the report form. Existing tickets keep it and are unchanged.`
          : `People will be able to choose ${current.nameEn} on the report form again.`}
      </p>
    </Dialog>
  )
}

function Places({ ready }: { ready: boolean }) {
  const { can } = useAuth()
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [toggling, setToggling] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const manage = can('admin.locations')
  const list = allBuildings()

  async function refresh() {
    await loadCatalogs(true)
    await loadAllCatalogs(true)
  }

  return (
    <Stack>
      <p className="text-[14px] text-muted">Buildings and floors people choose from on the report form.</p>
      {notice && <Alert tone="ok">{notice}</Alert>}
      {error && <Alert tone="bad">{error}</Alert>}
      {manage && <Button className="self-start" onClick={() => setAdding(true)}>Add place</Button>}
      {!ready ? <Skeleton className="h-40" /> : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {list.map((b) => (
            <Card key={b.code}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-[15px] font-semibold">{b.nameEn}</p>
                  <p className="truncate text-[13px] text-muted">{b.nameHi}</p>
                </div>
                {!b.active && <Badge>Retired</Badge>}
              </div>
              <p className="mt-2 text-[13px]">Floors: {b.floors.join(', ')}</p>
              {manage && (
                <div className="mt-2 flex flex-wrap gap-1">
                  <Button size="sm" variant="ghost" className="-ml-3" onClick={() => setEditing(b.code)}><Pencil size={15} /> Edit</Button>
                  <Button size="sm" variant="ghost" onClick={() => setToggling(b.code)}><Power size={15} /> {b.active ? 'Retire' : 'Restore'}</Button>
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
      {adding && (
        <ActionDialog open title="Add place" confirmLabel="Add"
          fields={[{ name: 'nameEn', label: 'Name (English)', required: true }, { name: 'nameHi', label: 'Name (Hindi)', required: true },
            { name: 'code', label: 'Short code', required: true, placeholder: 'e.g. INC' }, { name: 'floors', label: 'Floors, comma separated', required: true, placeholder: 'Ground, 1, 2' }]}
          onClose={() => setAdding(false)}
          onSubmit={async (v) => {
            await request('POST', '/admin/buildings', { body: { code: v.code.toUpperCase(), nameEn: v.nameEn, nameHi: v.nameHi,
              floors: v.floors.split(',').map((s) => s.trim()).filter(Boolean) } })
            await refresh()
          }} />
      )}
      {editing && <EditBuildingDialog code={editing} onClose={() => setEditing(null)}
        onSaved={async (msg) => { setEditing(null); setNotice(msg); await refresh() }}
        onError={(msg) => { setEditing(null); setError(msg) }} />}
      {toggling && <ToggleCatalogDialog code={toggling} kind="place" onClose={() => setToggling(null)}
        onSaved={async (msg) => { setToggling(null); setNotice(msg); await refresh() }}
        onError={(msg) => { setToggling(null); setError(msg) }} />}
    </Stack>
  )
}

function EditBuildingDialog({ code, onClose, onSaved, onError }: { code: string; onClose: () => void; onSaved: (m: string) => void; onError: (m: string) => void }) {
  const b = allBuildings().find((x) => x.code === code)
  const [nameEn, setNameEn] = useState(b?.nameEn ?? '')
  const [nameHi, setNameHi] = useState(b?.nameHi ?? '')
  const [floors, setFloors] = useState((b?.floors ?? []).join(', '))
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const floorList = floors.split(',').map((s) => s.trim()).filter(Boolean)

  async function save(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setError(null)
    try {
      await api.editBuilding(code, { nameEn: nameEn.trim(), nameHi: nameHi.trim(), floors: floorList })
      onSaved(`${nameEn.trim()} updated.`)
    } catch (err) { onError(errorMessage(err)) } finally { setBusy(false) }
  }

  if (!b) return null
  return (
    <Dialog open onClose={onClose} title={`Edit place: ${b.nameEn}`}>
      <form onSubmit={save} className="space-y-4">
        <p className="token text-[13px] text-muted">Code {b.code} stays the same, so existing tickets keep their place.</p>
        <Field label="Name (English)">{(id) => <Input id={id} value={nameEn} onChange={(e) => setNameEn(e.target.value)} maxLength={80} required />}</Field>
        <Field label="Name (Hindi)">{(id) => <Input id={id} value={nameHi} onChange={(e) => setNameHi(e.target.value)} maxLength={80} required />}</Field>
        <Field label="Floors" hint="Comma separated, e.g. Ground, 1, 2">
          {(id, d) => <Input id={id} aria-describedby={d} value={floors} onChange={(e) => setFloors(e.target.value)} maxLength={400} required />}
        </Field>
        {error && <Alert tone="bad">{error}</Alert>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={busy} disabled={!nameEn.trim() || !nameHi.trim() || !floorList.length}>Save</Button>
        </div>
      </form>
    </Dialog>
  )
}

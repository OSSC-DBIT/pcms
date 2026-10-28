import { useCallback, useEffect, useRef, useState } from 'react'
import { Download, FileSpreadsheet, KeyRound, Pencil, Power, RefreshCw, Upload, UserPlus } from 'lucide-react'
import { useAuth } from '../../App'
import { ActionDialog } from '../../components/ActionDialog'
import { Pager } from '../../components/Pager'
import { Alert, Badge, Button, Card, Dialog, EmptyState, Field, Input, PageHeader, Select, Skeleton, Stack, Tabs, errorMessage } from '../../components/ui'
import { api } from '../../lib/api'
import { allBuildings, allCategories, loadAllCatalogs, loadCatalogs } from '../../lib/catalog'
import { useT, type TKey } from '../../lib/i18n'
import { request, saveBlob } from '../../lib/http'
import type { AdminUser, Credential, Role } from '../../lib/types'

const ROLE_KEY: Record<Role, TKey> = {
  faculty: 'admin.role.faculty', facility_manager: 'admin.role.facility_manager',
  management: 'admin.role.management', ossc: 'admin.role.ossc',
}
const ROLES = Object.keys(ROLE_KEY) as Role[]
const IST: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }

/** A random initial password. The admin can see and replace it before creating the account. */
function suggestPassword(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12))
  const token = Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 14)
  return `Tmp-${token}-26`
}

export default function Admin() {
  const { can } = useAuth()
  const { t } = useT()
  const tabs = [
    ...(can('admin.users') ? [{ value: 'users' as const, label: t('admin.tabPeople') }] : []),
    { value: 'types' as const, label: t('admin.tabTypes') },
    { value: 'places' as const, label: t('admin.tabPlaces') },
  ]
  const [tab, setTab] = useState(tabs[0].value)
  const [ready, setReady] = useState(false)
  // The admin screens need retired rows too, so they hold their own copy of the list.
  useEffect(() => { void loadAllCatalogs().then(() => setReady(true)).catch(() => setReady(true)) }, [])
  return (
    <Stack>
      <PageHeader title={t('admin.title')} />
      <Tabs label={t('admin.section')} value={tab} onChange={setTab} tabs={tabs} />
      {tab === 'users' && <People />}
      {tab === 'types' && <Types ready={ready} />}
      {tab === 'places' && <Places ready={ready} />}
    </Stack>
  )
}

function CredentialDialog({ cred, onClose }: { cred: Credential | null; onClose: () => void }) {
  const { t } = useT()
  const [copied, setCopied] = useState(false)
  return (
    <Dialog open={!!cred} onClose={() => { setCopied(false); onClose() }} title={t('admin.tempPassword')}
      footer={<Button onClick={() => { setCopied(false); onClose() }}>{t('admin.done')}</Button>}>
      {cred && (
        <Stack>
          <p className="text-[14px]">{t('admin.credFor')} <b>{cred.user.name}</b> ({cred.user.email}). {t('admin.credMustChange')}</p>
          <p className="token select-all rounded-md bg-subtle px-4 py-3 text-center text-[24px] font-bold">{cred.temporaryPassword}</p>
          <p className="text-[13px] text-muted">{cred.expiresAt ? `${t('admin.credExpires')} ${new Date(cred.expiresAt).toLocaleString('en-IN', IST)}. ` : ''}{t('admin.credDirect')}</p>
          <Button variant="secondary" onClick={async () => { await navigator.clipboard.writeText(cred.temporaryPassword); setCopied(true) }}>{copied ? t('admin.copied') : t('admin.copy')}</Button>
        </Stack>
      )}
    </Dialog>
  )
}

function People() {
  const { user: me } = useAuth()
  const { t } = useT()
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
        <Button onClick={() => setAdding(true)}><UserPlus size={17} /> {t('admin.addPerson')}</Button>
        <Button variant="secondary" onClick={() => setImporting(true)}><Upload size={17} /> {t('admin.importFile')}</Button>
        <Button variant="secondary" onClick={() => setExporting(true)}><FileSpreadsheet size={17} /> {t('admin.credFile')}</Button>
      </div>
      <div className="flex flex-wrap gap-3">
        <div className="w-full sm:w-64">
          <Input value={q} onChange={(e) => { setQ(e.target.value); setPage(1) }} placeholder={t('admin.searchPeople')} aria-label={t('admin.searchPeopleLabel')} />
        </div>
        <div className="w-48">
          <Select aria-label={t('admin.filterRole')} value={role} onChange={(e) => { setRole(e.target.value as Role | ''); setPage(1) }}>
            <option value="">{t('admin.allRoles')}</option>{ROLES.map((r) => <option key={r} value={r}>{t(ROLE_KEY[r])}</option>)}
          </Select>
        </div>
      </div>
      {error && <Alert tone="bad">{error}</Alert>}
      {users === null ? <Skeleton className="h-40" /> : (
        <>
          {users.length === 0 && !q && !role && <EmptyState title={t('admin.noAccounts')} body={t('admin.noAccountsBody')} />}
          {users.length > 0 && (
            <div className="overflow-hidden rounded-lg border border-line bg-surface">
              {users.map((u) => (
                <div key={u.id} className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3 last:border-b-0">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[15px] font-medium">{u.name}</p>
                    <p className="token text-[13px] text-muted">{u.email} · {t(ROLE_KEY[u.role])}</p>
                    <p className="mt-0.5 text-[12px] text-muted">
                      {u.mustChangePassword
                        ? (u.tempPasswordExpiresAt ? `${t('admin.tempExpires')} ${new Date(u.tempPasswordExpiresAt).toLocaleString('en-IN', IST)}` : t('admin.noTemp'))
                        : (u.passwordChangedAt ? `${t('admin.pwChanged')} ${new Date(u.passwordChangedAt).toLocaleString('en-IN', IST)}` : t('admin.pwSet'))}
                    </p>
                  </div>
                  <Badge tone={!u.active ? 'bad' : u.mustChangePassword ? 'warn' : 'ok'}>{!u.active ? t('admin.suspended') : u.mustChangePassword ? t('admin.notActivated') : t('admin.active')}</Badge>
                  {u.id !== me?.id && (
                    <div className="flex flex-wrap gap-1">
                      <Button size="sm" variant="ghost" onClick={() => setAction({ user: u, kind: 'reset' })}><KeyRound size={15} /> {t('admin.reset')}</Button>
                      <Button size="sm" variant="ghost" onClick={() => setAction({ user: u, kind: 'role' })}>{t('admin.roleBtn')}</Button>
                      <Button size="sm" variant={u.active ? 'danger' : 'secondary'} onClick={() => setAction({ user: u, kind: u.active ? 'suspend' : 'reactivate' })}>{u.active ? t('admin.suspend') : t('admin.reactivate')}</Button>
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
        <ActionDialog open title={`${t('admin.resetFor')} ${action.user.email}`} confirmLabel={t('admin.issueNew')}
          description={t('admin.resetDesc')}
          fields={[
            { name: 'password', label: t('admin.newTempPw'), hint: t('admin.newTempPwHint') },
            ...(action.user.totpEnabled ? [{ name: 'mfa', label: t('admin.resetMfa'), type: 'select' as const, required: true, options: [{ value: 'no', label: t('admin.no') }, { value: 'yes', label: t('admin.lostPhone') }] }] : []),
          ]}
          onClose={() => setAction(null)}
          onSubmit={async (v) => { const c = await api.resetUserPassword(action.user, v.mfa === 'yes', v.password); replace(c.user); setCred(c) }} />
      )}
      {(action?.kind === 'suspend' || action?.kind === 'reactivate') && (
        <ActionDialog open title={`${action.kind === 'suspend' ? t('admin.suspend') : t('admin.reactivate')} ${action.user.email}`} danger={action.kind === 'suspend'}
          confirmLabel={action.kind === 'suspend' ? t('admin.suspend') : t('admin.reactivate')} fields={[{ name: 'reason', label: t('admin.reason'), type: 'textarea', required: true }]}
          onClose={() => setAction(null)}
          onSubmit={async (v) => replace(await api.updateUser(action.user, { active: action.kind === 'reactivate', reason: v.reason }))} />
      )}
      {action?.kind === 'role' && (
        <ActionDialog open title={`${t('admin.changeRoleOf')} ${action.user.email}`} confirmLabel={t('admin.changeRole')} description={t('admin.changeRoleDesc')}
          fields={[{ name: 'role', label: t('admin.newRole'), type: 'select', required: true, options: ROLES.filter((r) => r !== action.user.role).map((r) => ({ value: r, label: t(ROLE_KEY[r]) })) },
            { name: 'reason', label: t('admin.reason'), type: 'textarea', required: true }]}
          onClose={() => setAction(null)}
          onSubmit={async (v) => replace(await api.updateUser(action.user, { role: v.role as Role, reason: v.reason }))} />
      )}
      {exporting && (
        <ActionDialog open title={t('admin.downloadCred')} confirmLabel={t('admin.download')}
          description={t('admin.downloadCredDesc')}
          initial={{ scope: 'pending' }}
          fields={[
            { name: 'password', label: t('admin.yourPassword'), type: 'password', required: true },
            { name: 'scope', label: t('admin.whichAccounts'), type: 'select', required: true, options: [
              { value: 'pending', label: t('admin.onlyPending') },
              { value: 'all', label: t('admin.allAccounts') },
              { value: 'active', label: t('admin.onlyActive') },
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
  const { t } = useT()
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
    <Dialog open={open} onClose={close} title={t('admin.addPerson')}>
      <form onSubmit={save} className="space-y-4">
        <Field label={t('login.email')}>{(id) => <Input id={id} type="email" className="token" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" maxLength={254} required />}</Field>
        <Field label={t('admin.fullName')}>{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" maxLength={120} required />}</Field>
        <Field label={t('admin.tempPassword')} hint={t('admin.tempPwHint')}>
          {(id, d) => (
            <div className="flex gap-2">
              <Input id={id} aria-describedby={d} className="token flex-1" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" minLength={10} maxLength={128} required />
              <Button type="button" variant="secondary" onClick={() => setPassword(suggestPassword())}><RefreshCw size={15} /> {t('admin.suggest')}</Button>
            </div>
          )}
        </Field>
        <Field label={t('admin.roleBtn')}>{(id) => <Select id={id} value={role} onChange={(e) => setRole(e.target.value as Role)}>{ROLES.map((r) => <option key={r} value={r}>{t(ROLE_KEY[r])}</option>)}</Select>}</Field>
        {error && <Alert tone="bad">{error}</Alert>}
        <div className="flex justify-end gap-2"><Button variant="secondary" onClick={close}>{t('action.cancel')}</Button><Button type="submit" loading={busy}>{t('admin.create')}</Button></div>
      </form>
    </Dialog>
  )
}

function ImportCsv({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useT()
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
    <Dialog open={open} onClose={close} title={t('admin.importTitle')}>
      <Stack>
        <p className="text-[14px]">{t('admin.importColumns')} <span className="token">email, name, role, password</span>. {t('admin.importRules')}</p>
        <Alert tone="warn">{t('admin.importWarn')}</Alert>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={async () => { try { const t = await api.importTemplate(); saveBlob(t.blob, t.filename) } catch (e) { setError(errorMessage(e)) } }}><Download size={16} /> {t('admin.template')}</Button>
          <Button onClick={() => input.current?.click()}><Upload size={16} /> {t('admin.chooseFile')}</Button>
        </div>
        <input ref={input} type="file" accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv" hidden onChange={(e) => void choose(e.target.files?.[0])} />
        {busy && !preview && <Skeleton className="h-12" />}
        {file && preview && (
          <Card>
            <p className="text-[14.5px] font-medium">{file.name}</p>
            <p className="mt-1 text-[14px]">{preview.toCreate} {t('admin.newAccounts')}</p>
            {preview.alreadyExist.length > 0 && <p className="mt-1 text-[13px] text-muted">{t('admin.alreadyExist')} {preview.alreadyExist.join(', ')}</p>}
            <Button className="mt-3" loading={busy} disabled={!preview.toCreate} onClick={run}>{t('admin.createAndDownload')}</Button>
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
  const { t } = useT()
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
      <p className="text-[14px] text-muted">{t('admin.typesHint')}</p>
      {notice && <Alert tone="ok">{notice}</Alert>}
      {error && <Alert tone="bad">{error}</Alert>}
      {manage && <Button className="self-start" onClick={() => setAdding(true)}>{t('admin.addType')}</Button>}
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
                {!c.active && <Badge>{t('admin.retired')}</Badge>}
              </div>
              <p className="mt-2 text-[13px] text-muted">{c.subtypesEn.join(', ')}</p>
              {manage && (
                <div className="mt-2 flex flex-wrap gap-1">
                  <Button size="sm" variant="ghost" className="-ml-3" onClick={() => setEditing(c.code)}><Pencil size={15} /> {t('admin.edit')}</Button>
                  <Button size="sm" variant="ghost" onClick={() => setToggling(c.code)}><Power size={15} /> {c.active ? t('admin.retire') : t('admin.restore')}</Button>
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
      {adding && (
        <ActionDialog open title={t('admin.addType')} confirmLabel={t('admin.add')}
          fields={[{ name: 'nameEn', label: t('admin.nameEn'), required: true }, { name: 'nameHi', label: t('admin.nameHi'), required: true },
            { name: 'letter', label: t('admin.tokenLetter'), required: true }, { name: 'parts', label: t('admin.partsComma'), hint: t('admin.otherAuto') }]}
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
  const { t } = useT()
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
      onSaved(`${nameEn.trim()} ${t('admin.updated')}`)
    } catch (err) { onError(errorMessage(err)) } finally { setBusy(false) }
  }

  if (!c) return null
  return (
    <Dialog open onClose={onClose} title={`${t('admin.editType')} ${c.nameEn}`}>
      <form onSubmit={save} className="space-y-4">
        <p className="text-[13px] text-muted">{t('admin.tokenLetterIs')} {c.letter} {t('admin.letterFixed')}</p>
        <Field label={t('admin.nameEn')}>{(id) => <Input id={id} value={nameEn} onChange={(e) => setNameEn(e.target.value)} maxLength={80} required />}</Field>
        <Field label={t('admin.nameHi')}>{(id) => <Input id={id} value={nameHi} onChange={(e) => setNameHi(e.target.value)} maxLength={80} required />}</Field>
        <Field label={t('admin.parts')} hint={t('admin.partsHint')}>
          {(id, d) => <Input id={id} aria-describedby={d} value={parts} onChange={(e) => setParts(e.target.value)} maxLength={400} />}
        </Field>
        {error && <Alert tone="bad">{error}</Alert>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>{t('action.cancel')}</Button>
          <Button type="submit" loading={busy} disabled={!nameEn.trim() || !nameHi.trim()}>{t('action.save')}</Button>
        </div>
      </form>
    </Dialog>
  )
}

function ToggleCatalogDialog({ code, kind, onClose, onSaved, onError }: {
  code: string; kind: 'type' | 'place'; onClose: () => void; onSaved: (m: string) => void; onError: (m: string) => void
}) {
  const { t } = useT()
  const isType = kind === 'type'
  const current = isType ? allCategories().find((x) => x.code === code) : allBuildings().find((x) => x.code === code)
  const active = current?.active ?? true
  const [busy, setBusy] = useState(false)

  async function go() {
    setBusy(true)
    try {
      if (isType) await api.editCategory(code, { active: !active })
      else await api.editBuilding(code, { active: !active })
      onSaved(`${current?.nameEn ?? code} ${active ? t('admin.retiredMsg') : t('admin.restoredMsg')}`)
    } catch (err) { onError(errorMessage(err)) } finally { setBusy(false) }
  }

  if (!current) return null
  return (
    <Dialog open onClose={onClose}
      title={isType ? (active ? t('admin.retireThisType') : t('admin.restoreThisType')) : (active ? t('admin.retireThisPlace') : t('admin.restoreThisPlace'))}
      footer={<><Button variant="secondary" onClick={onClose}>{t('action.cancel')}</Button><Button loading={busy} variant={active ? 'danger' : 'primary'} onClick={() => void go()}>{active ? t('admin.retire') : t('admin.restore')}</Button></>}>
      <p className="text-[14px]">
        <b>{current.nameEn}</b>: {active ? t('admin.retireBody') : t('admin.restoreBody')}
      </p>
    </Dialog>
  )
}

function Places({ ready }: { ready: boolean }) {
  const { can } = useAuth()
  const { t } = useT()
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
      <p className="text-[14px] text-muted">{t('admin.placesHint')}</p>
      {notice && <Alert tone="ok">{notice}</Alert>}
      {error && <Alert tone="bad">{error}</Alert>}
      {manage && <Button className="self-start" onClick={() => setAdding(true)}>{t('admin.addPlace')}</Button>}
      {!ready ? <Skeleton className="h-40" /> : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {list.map((b) => (
            <Card key={b.code}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-[15px] font-semibold">{b.nameEn}</p>
                  <p className="truncate text-[13px] text-muted">{b.nameHi}</p>
                </div>
                {!b.active && <Badge>{t('admin.retired')}</Badge>}
              </div>
              <p className="mt-2 text-[13px]">{t('admin.floorsLabel')} {b.floors.join(', ')}</p>
              {manage && (
                <div className="mt-2 flex flex-wrap gap-1">
                  <Button size="sm" variant="ghost" className="-ml-3" onClick={() => setEditing(b.code)}><Pencil size={15} /> {t('admin.edit')}</Button>
                  <Button size="sm" variant="ghost" onClick={() => setToggling(b.code)}><Power size={15} /> {b.active ? t('admin.retire') : t('admin.restore')}</Button>
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
      {adding && (
        <ActionDialog open title={t('admin.addPlace')} confirmLabel={t('admin.add')}
          fields={[{ name: 'nameEn', label: t('admin.nameEn'), required: true }, { name: 'nameHi', label: t('admin.nameHi'), required: true },
            { name: 'code', label: t('admin.shortCode'), required: true, placeholder: 'e.g. INC' }, { name: 'floors', label: t('admin.floorsComma'), required: true, placeholder: 'Ground, 1, 2' }]}
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
  const { t } = useT()
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
    <Dialog open onClose={onClose} title={`${t('admin.editPlace')} ${b.nameEn}`}>
      <form onSubmit={save} className="space-y-4">
        <p className="token text-[13px] text-muted">{t('admin.code')} {b.code} {t('admin.codeFixed')}</p>
        <Field label={t('admin.nameEn')}>{(id) => <Input id={id} value={nameEn} onChange={(e) => setNameEn(e.target.value)} maxLength={80} required />}</Field>
        <Field label={t('admin.nameHi')}>{(id) => <Input id={id} value={nameHi} onChange={(e) => setNameHi(e.target.value)} maxLength={80} required />}</Field>
        <Field label={t('admin.floors')} hint={t('admin.floorsHint')}>
          {(id, d) => <Input id={id} aria-describedby={d} value={floors} onChange={(e) => setFloors(e.target.value)} maxLength={400} required />}
        </Field>
        {error && <Alert tone="bad">{error}</Alert>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>{t('action.cancel')}</Button>
          <Button type="submit" loading={busy} disabled={!nameEn.trim() || !nameHi.trim() || !floorList.length}>{t('action.save')}</Button>
        </div>
      </form>
    </Dialog>
  )
}

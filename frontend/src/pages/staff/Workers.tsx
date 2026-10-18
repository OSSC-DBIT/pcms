import { useCallback, useEffect, useRef, useState } from 'react'
import { BookUser, FileUp, Phone, UserPlus } from 'lucide-react'
import { useAuth } from '../../App'
import { Alert, Badge, Button, Card, Dialog, EmptyState, Field, Input, PageHeader, Select, Skeleton, Stack, Tabs, errorMessage } from '../../components/ui'
import { api } from '../../lib/api'
import { categories, category } from '../../lib/catalog'
import { canPickContacts, parseContactsFile, pickContacts, type PickedContact } from '../../lib/contacts'
import type { Worker } from '../../lib/types'

type Mode = Worker['mode']
type Kind = Worker['kind']

const MODES: { value: Mode; label: string }[] = [{ value: 'call', label: 'Phone call' }, { value: 'whatsapp', label: 'WhatsApp' }, { value: 'sms', label: 'SMS' }]
const LANGS = [{ value: 'kn', label: 'Kannada' }, { value: 'hi', label: 'Hindi' }, { value: 'ta', label: 'Tamil' }, { value: 'te', label: 'Telugu' }, { value: 'en', label: 'English' }]

export default function Workers() {
  const { can } = useAuth()
  const [workers, setWorkers] = useState<Worker[] | null>(null)
  const [tab, setTab] = useState<'active' | 'all'>('active')
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [importing, setImporting] = useState<PickedContact[] | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const file = useRef<HTMLInputElement>(null)
  const manage = can('worker.manage')

  const load = useCallback(() => { api.listWorkers().then(setWorkers).catch((e) => { setWorkers([]); setError(errorMessage(e)) }) }, [])
  useEffect(load, [load])

  async function fromPhone() {
    setError(null)
    try {
      const picked = await pickContacts()
      if (picked.length) setImporting(picked)
    } catch (e) { setError(errorMessage(e, 'Could not open contacts.')) }
  }

  async function fromFile(f: File | undefined) {
    if (!f) return
    setError(null)
    const list = parseContactsFile(await f.text())
    if (file.current) file.current.value = ''
    if (!list.length) { setError('No contacts with a name and phone number were found in that file. Use a .vcf export or a CSV with name and phone columns.'); return }
    setImporting(list)
  }

  async function toggle(w: Worker) {
    setError(null)
    try { const nw = await api.updateWorker(w, { active: !w.active }); setWorkers((ws) => ws!.map((x) => x.id === nw.id ? nw : x)) }
    catch (e) { setError(errorMessage(e)); load() }
  }

  const shown = (workers ?? []).filter((w) => tab === 'all' || w.active)

  return (
    <Stack>
      <PageHeader title="Workers" subtitle="Contacts for dispatch. Workers do not log in; jobs reach them by call, WhatsApp or SMS."
        actions={manage && (
          <>
            <Button onClick={() => setAdding(true)}><UserPlus size={17} /> Add worker</Button>
            {canPickContacts() && <Button variant="secondary" onClick={fromPhone}><BookUser size={17} /> From phone contacts</Button>}
            <Button variant="secondary" onClick={() => file.current?.click()}><FileUp size={17} /> Import file</Button>
          </>
        )} />
      <input ref={file} type="file" accept=".vcf,.csv,text/vcard,text/csv" hidden onChange={(e) => void fromFile(e.target.files?.[0])} />
      {manage && !canPickContacts() && (
        <p className="text-[13px] text-muted">To import from a phone: open PCMS in Chrome on Android to pick contacts directly, or export contacts as a .vcf file and use Import file.</p>
      )}
      {notice && <Alert tone="ok">{notice}</Alert>}
      {error && <Alert tone="bad">{error}</Alert>}
      <Tabs label="Worker filter" value={tab} onChange={setTab} tabs={[{ value: 'active', label: 'Active' }, { value: 'all', label: 'All' }]} />
      {workers === null ? <Skeleton className="h-40" /> : shown.length === 0 ? <EmptyState title="No workers yet" body="Add workers so facility managers can dispatch jobs." /> : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {shown.map((w) => (
            <Card key={w.id}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-[15.5px] font-semibold">{w.name}</p>
                  <p className="token mt-0.5 flex items-center gap-1 text-[13px] text-muted"><Phone size={13} /> {w.phoneMasked}</p>
                </div>
                <Badge tone={w.active ? 'ok' : undefined}>{w.active ? `${w.workload} open` : 'Inactive'}</Badge>
              </div>
              <p className="mt-2 text-[13.5px]">{w.trades.map((c) => category(c).nameEn).join(', ')}</p>
              <p className="mt-0.5 text-[13px] text-muted">{MODES.find((m) => m.value === w.mode)?.label} · {w.kind} · {w.language.toUpperCase()}{w.area ? ` · ${w.area}` : ''}</p>
              {manage && <Button size="sm" variant="ghost" className="mt-2 -ml-3" onClick={() => toggle(w)}>{w.active ? 'Deactivate' : 'Activate'}</Button>}
            </Card>
          ))}
        </div>
      )}
      <AddWorker open={adding} onClose={() => setAdding(false)} onSaved={(w) => { setWorkers((ws) => [...(ws ?? []), w]); setNotice(`${w.name} added.`) }} />
      {importing && (
        <ImportReview contacts={importing} onClose={() => setImporting(null)}
          onDone={(msg) => { setImporting(null); setNotice(msg); load() }} />
      )}
    </Stack>
  )
}

function TradePicker({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  return (
    <div className="flex flex-wrap gap-2">
      {categories().map((c) => {
        const on = value.includes(c.code)
        return (
          <button key={c.code} type="button" aria-pressed={on} onClick={() => onChange(on ? value.filter((x) => x !== c.code) : [...value, c.code])}
            className={`min-h-9 rounded-full border px-3 text-[13.5px] ${on ? 'border-accent bg-accent text-accent-fg' : 'border-line'}`}>{c.nameEn}</button>
        )
      })}
    </div>
  )
}

function AddWorker({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: (w: Worker) => void }) {
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [trades, setTrades] = useState<string[]>([])
  const [mode, setMode] = useState<Mode>('call')
  const [kind, setKind] = useState<Kind>('employee')
  const [language, setLanguage] = useState('kn')
  const [area, setArea] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  function reset() { setName(''); setPhone(''); setTrades([]); setArea(''); setError(null) }

  async function save(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setError(null)
    try { onSaved(await api.createWorker({ name, phone, trades, area, language, mode, kind })); reset(); onClose() }
    catch (err) { setError(errorMessage(err)) } finally { setBusy(false) }
  }

  return (
    <Dialog open={open} onClose={() => { reset(); onClose() }} title="Add worker">
      <form onSubmit={save} className="space-y-4">
        <Field label="Name">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoComplete="off" required />}</Field>
        <Field label="Mobile number" hint="10-digit Indian mobile, e.g. 98450 12345">{(id, d) => <Input id={id} aria-describedby={d} value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" autoComplete="off" required />}</Field>
        <div><p className="mb-1.5 text-[14px] font-medium">Work (trade)</p><TradePicker value={trades} onChange={setTrades} /></div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Reach by">{(id) => <Select id={id} value={mode} onChange={(e) => setMode(e.target.value as Mode)}>{MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}</Select>}</Field>
          <Field label="Type">{(id) => <Select id={id} value={kind} onChange={(e) => setKind(e.target.value as Kind)}><option value="employee">College staff</option><option value="vendor">Vendor</option></Select>}</Field>
          <Field label="Language">{(id) => <Select id={id} value={language} onChange={(e) => setLanguage(e.target.value)}>{LANGS.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}</Select>}</Field>
          <Field label="Area" optional>{(id) => <Input id={id} value={area} onChange={(e) => setArea(e.target.value)} maxLength={120} placeholder="e.g. Whole campus" />}</Field>
        </div>
        {error && <Alert tone="bad">{error}</Alert>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => { reset(); onClose() }}>Cancel</Button>
          <Button type="submit" loading={busy} disabled={!name.trim() || !phone.trim() || !trades.length}>Save</Button>
        </div>
      </form>
    </Dialog>
  )
}

/** Picked contacts become workers only after the manager chooses their trade and channel. */
function ImportReview({ contacts, onClose, onDone }: { contacts: PickedContact[]; onClose: () => void; onDone: (msg: string) => void }) {
  const [rows, setRows] = useState(() => contacts.map((c) => ({ ...c, include: true, trades: [] as string[] })))
  const [mode, setMode] = useState<Mode>('call')
  const [kind, setKind] = useState<Kind>('employee')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const chosen = rows.filter((r) => r.include)
  const missingTrade = chosen.some((r) => r.trades.length === 0)

  async function save() {
    setBusy(true); setError(null)
    try {
      const res = await api.importWorkers(chosen.map((r) => ({ name: r.name, phone: r.phone, trades: r.trades, area: '', language: 'kn', mode, kind })))
      const created = res.filter((r) => r.status === 'created').length
      const skipped = res.filter((r) => r.status !== 'created')
      onDone(`${created} worker(s) added.${skipped.length ? ` Skipped: ${skipped.map((s) => `${s.name} (${s.status === 'exists' ? 'already added' : s.message})`).join(', ')}.` : ''}`)
    } catch (e) { setError(errorMessage(e)) } finally { setBusy(false) }
  }

  return (
    <Dialog open onClose={onClose} title={`Import ${contacts.length} contact(s)`} wide>
      <Stack>
        <p className="text-[14px] text-muted">Choose each person's work. Untick anyone you do not want to add.</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Reach all by">{(id) => <Select id={id} value={mode} onChange={(e) => setMode(e.target.value as Mode)}>{MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}</Select>}</Field>
          <Field label="Type">{(id) => <Select id={id} value={kind} onChange={(e) => setKind(e.target.value as Kind)}><option value="employee">College staff</option><option value="vendor">Vendor</option></Select>}</Field>
        </div>
        <ul className="max-h-[50vh] space-y-3 overflow-y-auto pr-1">
          {rows.map((r, i) => (
            <li key={`${r.phone}-${i}`} className="rounded-md border border-line p-3">
              <label className="flex items-center gap-3">
                <input type="checkbox" className="h-5 w-5 accent-[var(--c-accent)]" checked={r.include}
                  onChange={(e) => setRows((rs) => rs.map((x, j) => j === i ? { ...x, include: e.target.checked } : x))} />
                <span className="min-w-0"><span className="block truncate text-[14.5px] font-medium">{r.name}</span><span className="token text-[13px] text-muted">{r.phone}</span></span>
              </label>
              {r.include && <div className="mt-2"><TradePicker value={r.trades} onChange={(v) => setRows((rs) => rs.map((x, j) => j === i ? { ...x, trades: v } : x))} /></div>}
            </li>
          ))}
        </ul>
        {error && <Alert tone="bad">{error}</Alert>}
        <div className="flex flex-wrap items-center justify-end gap-2">
          {missingTrade && <span className="mr-auto text-[13px] text-bad">Choose work for every ticked contact.</span>}
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button loading={busy} disabled={!chosen.length || missingTrade} onClick={save}>Add {chosen.length} worker(s)</Button>
        </div>
      </Stack>
    </Dialog>
  )
}

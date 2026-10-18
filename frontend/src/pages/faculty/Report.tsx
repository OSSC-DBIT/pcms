import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { Navigate, Route, Routes, useNavigate } from 'react-router-dom'
import { Camera, Paperclip, X } from 'lucide-react'
import { Button, Card, CheckChip, Field, NavBar, Row, Sheet, TextInput, spring } from '../../components/ui'
import { BUILDINGS, CATEGORIES, HttpError, api, category, localName, localSubtypes } from '../../lib/api'
import { useT } from '../../lib/i18n'
import type { Draft, Ticket } from '../../lib/types'
import { motion } from 'framer-motion'

interface Media { id: string; kind: 'photo' | 'video'; name: string; sizeBytes: number; dataUrl?: string; error?: string }

interface Wiz {
  draft: Draft
  set: (patch: Partial<Draft>) => void
  media: Media[]
  addMedia: (files: FileList) => void
  removeMedia: (id: string) => void
  requestKey: string
}

const DRAFTS_KEY = 'pcms.drafts'
const emptyDraft = (): Draft => ({
  key: crypto.randomUUID(), savedAt: new Date().toISOString(), title: '', description: '',
  categoryCode: '', location: { building: '', floor: '', room: '' }, impact: 'routine',
})

function loadDraft(): Draft | null {
  try { return (JSON.parse(localStorage.getItem(DRAFTS_KEY) ?? '[]') as Draft[])[0] ?? null } catch { return null }
}

const WizCtx = createContext<Wiz | null>(null)
const useWiz = () => { const w = useContext(WizCtx); if (!w) throw new Error('wiz'); return w }

const STEPS = ['/report', '/report/location', '/report/details', '/report/impact', '/report/evidence', '/report/review'] as const

export default function Report() {
  const [draft, setDraft] = useState<Draft>(() => loadDraft() ?? emptyDraft())
  const [media, setMedia] = useState<Media[]>([])
  const requestKey = useRef(draft.key).current

  const set = (patch: Partial<Draft>) => {
    const next = { ...draft, ...patch, savedAt: new Date().toISOString() }
    setDraft(next)
    localStorage.setItem(DRAFTS_KEY, JSON.stringify([next]))
  }

  const MAX_PHOTO = 5 * 1024 * 1024
  const MAX_VIDEO = 20 * 1024 * 1024
  const addMedia = (files: FileList) => {
    const out: Media[] = Array.from(files).map((f) => {
      const kind = f.type.startsWith('video') ? 'video' as const : 'photo' as const
      const tooBig = kind === 'video' ? f.size > MAX_VIDEO : f.size > MAX_PHOTO
      return { id: crypto.randomUUID(), kind, name: f.name, sizeBytes: f.size, error: tooBig ? (kind === 'video' ? 'Video is over 20 MB.' : 'Photo is over 5 MB.') : undefined, file: f } as Media & { file: File }
    })
    setMedia((m) => [...m, ...out].slice(0, 4))
    out.forEach((o) => {
      if (!o.error && o.kind === 'photo') {
        const reader = new FileReader()
        reader.onload = () => setMedia((m) => m.map((x) => x.id === o.id ? { ...x, dataUrl: String(reader.result) } : x))
        reader.readAsDataURL((o as Media & { file: File }).file)
      }
    })
  }
  const removeMedia = (id: string) => setMedia((m) => m.filter((x) => x.id !== id))

  const wiz: Wiz = useMemo(() => ({ draft, set, media, addMedia, removeMedia, requestKey }), [draft, media, requestKey])

  return (
    <WizCtx.Provider value={wiz}>
      <div className="mx-auto min-h-dvh max-w-lg">
        <Routes>
          <Route path="/" element={<StepType />} />
          <Route path="/location" element={<StepLocation />} />
          <Route path="/details" element={<StepDetails />} />
          <Route path="/impact" element={<StepImpact />} />
          <Route path="/evidence" element={<StepEvidence />} />
          <Route path="/review" element={<StepReview />} />
          <Route path="*" element={<Navigate to="/report" replace />} />
        </Routes>
      </div>
    </WizCtx.Provider>
  )
}

function StepShell({ path, title, children, canNext, onNext, nextLabel }:
  { path: number; title: string; children: React.ReactNode; canNext: boolean; onNext: () => void; nextLabel?: string }) {
  const { t } = useT()
  const nav = useNavigate()
  return (
    <div className="flex min-h-dvh flex-col">
      <NavBar title={title} onBack={() => nav(-1)} />
      <div className="h-[3px] w-full bg-line" aria-hidden>
        <motion.div initial={false} animate={{ width: `${((path + 1) / STEPS.length) * 100}%` }} transition={spring} className="h-full bg-inverse" />
      </div>
      <div className="flex-1 pb-36">{children}</div>
      <div className="safe-bottom fixed inset-x-0 bottom-0 mx-auto flex max-w-lg gap-3 border-t border-line bg-bg/90 px-4 pb-4 pt-3 backdrop-blur-2xl">
        <Button variant="secondary" className="max-w-32 flex-none" onClick={() => nav('/')}><X size={15} className="mr-0.5" /></Button>
        <Button onClick={onNext} disabled={!canNext}>{nextLabel ?? t('action.next')}</Button>
      </div>
    </div>
  )
}

function StepType() {
  const { t, lang } = useT()
  const { draft, set } = useWiz()
  const nav = useNavigate()
  const [open, setOpen] = useState(true)
  const cat = draft.categoryCode ? category(draft.categoryCode) : null
  return (
    <StepShell path={0} title={t('form.type')} canNext={!!draft.categoryCode} onNext={() => nav('/report/location')}>
      <button onClick={() => setOpen(true)} className="w-full px-4 pt-5 text-left">
        <Card>
          <Row title={cat ? localName(cat, lang) : t('form.type')} detail={cat ? (lang === 'en' ? 'Change' : lang === 'hi' ? 'बदलें' : 'ಬದಲಿಸಿ') : undefined} selected={!cat} />
        </Card>
      </button>
      {cat && (
        <div className="px-4 pt-5">
          <p className="mb-2.5 text-[13px] font-semibold text-muted">{t('form.subtype')}</p>
          <div className="flex flex-wrap gap-2">
            {localSubtypes(cat, lang).map((s, i) => (
              <CheckChip key={s} selected={draft.subtype === cat.subtypesEn[i]} onClick={() => set({ subtype: cat.subtypesEn[i] })}>{s}</CheckChip>
            ))}
          </div>
        </div>
      )}
      <Sheet open={open && !cat} onClose={() => setOpen(false)} title={t('form.type')}>
        <div className="inset-hr mt-2">
          {CATEGORIES.map((c) => (
            <Row key={c.code} title={localName(c, lang)}
              detail={<span className="token">{c.letter}</span>}
              chevron={false}
              onClick={() => { set({ categoryCode: c.code, subtype: undefined }); setOpen(false) }} />
          ))}
        </div>
      </Sheet>
    </StepShell>
  )
}

function StepLocation() {
  const { t, lang } = useT()
  const { draft, set } = useWiz()
  const nav = useNavigate()
  const [pickBuilding, setPickBuilding] = useState(false)
  const building = BUILDINGS.find((b) => b.code === draft.location.building)
  const canNext = draft.location.outdoors ? !!draft.location.landmark : !!draft.location.building && !!draft.location.room
  return (
    <StepShell path={1} title={t('form.location')} canNext={canNext} onNext={() => nav('/report/details')}>
      <div className="space-y-3 px-4 pt-5">
        <Card>
          <Row title={t('form.outdoors')} detail={draft.location.outdoors ? undefined : 'In a building'}
            right={<CheckChip selected={!!draft.location.outdoors} onClick={() => set({ location: { ...draft.location, outdoors: !draft.location.outdoors } })}>{draft.location.outdoors ? 'On' : 'Off'}</CheckChip>}
            chevron={false} />
        </Card>
        {!draft.location.outdoors ? (
          <Card className="inset-hr">
            <button className="w-full text-left" onClick={() => setPickBuilding(true)}>
              <Row title={building ? localName(building, lang) : t('form.building')} selected={!building} />
            </button>
            {building && (
              <div className="px-4 py-3">
                <p className="mb-2 text-[13px] font-semibold text-muted">{t('form.floor')}</p>
                <div className="flex flex-wrap gap-2">
                  {['Ground', ...building.floors.filter((f) => f !== 'Ground')].map((f) => (
                    <CheckChip key={f} selected={draft.location.floor === f} onClick={() => set({ location: { ...draft.location, floor: f } })}>{f}</CheckChip>
                  ))}
                </div>
              </div>
            )}
            <Field label={t('form.room')}>
              <TextInput value={draft.location.room} onChange={(e) => set({ location: { ...draft.location, room: e.target.value } })} placeholder="203" />
            </Field>
          </Card>
        ) : (
          <Card>
            <Field label={t('form.landmark')}>
              <TextInput value={draft.location.landmark ?? ''} onChange={(e) => set({ location: { ...draft.location, landmark: e.target.value } })} placeholder="Near the main gate" />
            </Field>
          </Card>
        )}
      </div>
      <Sheet open={pickBuilding} onClose={() => setPickBuilding(false)} title={t('form.building')}>
        <div className="inset-hr mt-2">
          {BUILDINGS.map((b) => (
            <Row key={b.code} title={localName(b, lang)} selected={draft.location.building === b.code}
              onClick={() => { set({ location: { ...draft.location, building: b.code, floor: '' } }); setPickBuilding(false) }} />
          ))}
        </div>
      </Sheet>
    </StepShell>
  )
}

function StepDetails() {
  const { t } = useT()
  const { draft, set } = useWiz()
  const nav = useNavigate()
  return (
    <StepShell path={2} title={t('form.title')} canNext={draft.title.trim().length >= 4} onNext={() => nav('/report/impact')}>
      <Card className="mx-4 mt-5">
        <Field label={t('form.title')} hint={`${draft.title.length}/120`}>
          <TextInput maxLength={120} value={draft.title} onChange={(e) => set({ title: e.target.value })} placeholder="Broken chair in lecture room" />
        </Field>
        <Field label={t('form.description')} hint={`${draft.description.length}/2000`}>
          <textarea maxLength={2000} value={draft.description} onChange={(e) => set({ description: e.target.value })} rows={6}
            placeholder="What failed, when it started, and how it affects classes."
            className="w-full resize-none rounded-[11px] border border-line bg-surface px-3.5 py-3 text-[16px] leading-6 placeholder:text-muted/55 focus:border-fg/50" />
        </Field>
      </Card>
    </StepShell>
  )
}

function StepImpact() {
  const { t } = useT()
  const { draft, set } = useWiz()
  const nav = useNavigate()
  const impacts = [
    { v: 'safety', k: 'form.impact.safety' },
    { v: 'class_interrupted', k: 'form.impact.class' },
    { v: 'multiple_areas', k: 'form.impact.multiple' },
    { v: 'routine', k: 'form.impact.routine' },
  ] as const
  return (
    <StepShell path={3} title={t('form.impact')} canNext onNext={() => nav('/report/evidence')}>
      <Card className="inset-hr mx-4 mt-5">
        {impacts.map(({ v, k }) => <Row key={v} title={t(k)} selected={draft.impact === v} chevron={false} onClick={() => set({ impact: v })} />)}
      </Card>
      {draft.impact === 'safety' && (
        <div className="px-4 pt-4">
          <motion.p initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} transition={spring}
            className="pretty rounded-[13px] border border-fg/30 bg-surface px-4 py-3 text-[13.5px] font-medium leading-5">
            Electrical fault, fire or major flooding? Call the campus emergency number first. Register the issue after you are safe.
          </motion.p>
        </div>
      )}
      <Card className="mx-4 mt-4">
        <Field label={t('form.access')} hint="optional">
          <TextInput value={draft.accessNote ?? ''} onChange={(e) => set({ accessNote: e.target.value })} placeholder="After 4 pm, caretaker on floor" />
        </Field>
      </Card>
    </StepShell>
  )
}

function StepEvidence() {
  const { t } = useT()
  const { media, addMedia, removeMedia } = useWiz()
  const nav = useNavigate()
  const cameraRef = useRef<HTMLInputElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  return (
    <StepShell path={4} title={t('form.evidence')} canNext onNext={() => nav('/report/review')}>
      <p className="px-4 pt-5 text-[13px] text-muted">{t('form.evidenceHint')}</p>
      <div className="grid grid-cols-2 gap-3 px-4 pt-3">
        <button onClick={() => cameraRef.current?.click()}
          className="flex h-[110px] flex-col items-center justify-center gap-2 rounded-[14px] border border-line bg-surface text-[13.5px] font-semibold shadow-[0_1px_2px_rgba(0,0,0,0.04)] active:scale-[0.98] transition-transform">
          <Camera size={19} className="text-muted" /> {t('form.camera')}
        </button>
        <button onClick={() => fileRef.current?.click()}
          className="flex h-[110px] flex-col items-center justify-center gap-2 rounded-[14px] border border-line bg-surface text-[13.5px] font-semibold shadow-[0_1px_2px_rgba(0,0,0,0.04)] active:scale-[0.98] transition-transform">
          <Paperclip size={19} className="text-muted" /> {t('form.upload')}
        </button>
        <input ref={cameraRef} type="file" accept="image/*,video/*" capture="environment" hidden onChange={(e) => e.target.files && addMedia(e.target.files)} />
        <input ref={fileRef} type="file" accept="image/*,video/*" multiple hidden onChange={(e) => e.target.files && addMedia(e.target.files)} />
      </div>
      {media.length > 0 && (
        <Card className="inset-hr mx-4 mt-4">
          {media.map((m) => (
            <div key={m.id} className="flex min-h-[56px] items-center gap-3 px-4 py-2.5">
              {m.dataUrl ? <img src={m.dataUrl} alt="" className="h-10 w-10 rounded-[9px] object-cover" /> : <Paperclip size={15} className="mx-[9px] text-muted" />}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14.5px] font-medium">{m.name}</span>
                <span className="token block text-[11.5px] text-muted">{m.error ?? `${(m.sizeBytes / 1024 / 1024).toFixed(1)} MB`}</span>
              </span>
              <button aria-label={t('action.remove')} onClick={() => removeMedia(m.id)} className="flex h-9 w-9 items-center justify-center rounded-full bg-fg/8 text-muted active:scale-90 transition-transform"><X size={14} /></button>
            </div>
          ))}
        </Card>
      )}
    </StepShell>
  )
}

function StepReview() {
  const { t, lang } = useT()
  const { draft, media, requestKey } = useWiz()
  const nav = useNavigate()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dups, setDups] = useState<Ticket[]>([])
  const cat = category(draft.categoryCode)

  useEffect(() => {
    let live = true
    api.findDuplicates(draft.location, draft.categoryCode).then((d) => live && setDups(d))
    return () => { live = false }
  }, [draft.location, draft.categoryCode])

  async function submit() {
    setBusy(true)
    setError(null)
    try {
      const user = api.restore()
      if (!user) throw new HttpError('unauthorized', 'Sign in again to send this report. Your draft is kept.')
      const ticket = await api.createTicket(user, draft, requestKey)
      localStorage.removeItem(DRAFTS_KEY)
      for (const m of media.filter((x) => !x.error)) {
        try { await api.attachMedia(ticket.id, m) } catch { /* evidence failure keeps the ticket */ }
      }
      nav(`/receipt/${ticket.id}`, { replace: true })
    } catch (err) {
      setError(err instanceof HttpError ? err.message : 'Submission failed. Your draft is kept on this device.')
    } finally {
      setBusy(false)
    }
  }

  const subtypeLabel = draft.subtype ? localSubtypes(cat, lang)[cat.subtypesEn.indexOf(draft.subtype)] ?? draft.subtype : null
  const rows: [string, string][] = [
    [t('form.type'), `${localName(cat, lang)}${subtypeLabel ? ` · ${subtypeLabel}` : ''}`],
    [t('form.location'), draft.location.outdoors ? `${t('form.outdoors')}${draft.location.landmark ? ` · ${draft.location.landmark}` : ''}` : `${localName(BUILDINGS.find((b) => b.code === draft.location.building) ?? { nameEn: draft.location.building, nameHi: draft.location.building, nameKn: draft.location.building }, lang)} · ${draft.location.floor || '—'} · ${draft.location.room || '—'}`],
    [t('form.impact'), t(draft.impact === 'safety' ? 'form.impact.safety' : draft.impact === 'class_interrupted' ? 'form.impact.class' : draft.impact === 'multiple_areas' ? 'form.impact.multiple' : 'form.impact.routine')],
    [t('form.evidence'), media.length ? String(media.length) : 'None'],
  ]

  return (
    <StepShell path={5} title={t('form.review')} canNext={!busy} onNext={submit} nextLabel={t('action.done')}>
      {dups.length > 0 && (
        <div className="px-4 pt-5">
          <p className="pretty rounded-[13px] border border-line bg-surface px-4 py-3 text-[13px] leading-5">
            <span className="font-semibold">Similar report already open here.</span>{' '}
            {dups.map((d) => <span key={d.id} className="token">{d.token}</span>)} — continue only if the fault is different.
          </p>
        </div>
      )}
      <Card className="inset-hr mx-4 mt-5">
        <Row title={draft.title || '—'} detail={draft.description ? `${draft.description.slice(0, 110)}${draft.description.length > 110 ? '…' : ''}` : undefined} chevron={false} />
        {rows.map(([k, v]) => (
          <div key={k} className="flex min-h-[48px] items-center justify-between gap-6 px-4 py-2.5">
            <span className="text-[13px] font-medium text-muted">{k}</span>
            <span className="text-right text-[14.5px] font-medium">{v}</span>
          </div>
        ))}
      </Card>
      {error && <div className="px-4 pt-4"><p role="alert" className="pretty rounded-[13px] border border-fg/25 bg-surface px-4 py-3 text-[13.5px] leading-5">{error}</p></div>}
      <p className="pretty px-6 pt-4 text-center text-[12px] leading-4 text-muted">{t('draft.label')} — saved on this device until sent.</p>
    </StepShell>
  )
}

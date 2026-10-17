import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { Navigate, Route, Routes, useNavigate } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { Camera, Paperclip, X } from 'lucide-react'
import { Button, Fade, Field, NavBar, OptionRow, Segmented, TextInput } from '../../components/ui'
import { BUILDINGS, CATEGORIES, HttpError, api, category } from '../../lib/api'
import { useT, type TKey } from '../../lib/i18n'
import type { Draft, Ticket } from '../../lib/types'

interface Media { id: string; kind: 'photo' | 'video'; name: string; sizeBytes: number; dataUrl?: string; error?: string }

interface Wizard {
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

function loadDrafts(): Draft[] {
  try { return JSON.parse(localStorage.getItem(DRAFTS_KEY) ?? '[]') as Draft[] } catch { return [] }
}

const WizCtx = createContext<Wizard | null>(null)
const useWiz = () => { const w = useContext(WizCtx); if (!w) throw new Error('wiz'); return w }

export default function Raise() {
  const [draft, setDraft] = useState<Draft>(() => {
    const drafts = loadDrafts()
    return drafts[0] ?? emptyDraft()
  })
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
    const out: Media[] = []
    Array.from(files).forEach((f) => {
      const kind = f.type.startsWith('video') ? 'video' as const : 'photo' as const
      const tooBig = kind === 'video' ? f.size > MAX_VIDEO : f.size > MAX_PHOTO
      out.push({ id: crypto.randomUUID(), kind, name: f.name, sizeBytes: f.size, error: tooBig ? (kind === 'video' ? 'Video is over 20 MB.' : 'Photo is over 5 MB.') : undefined })
    })
    setMedia((m) => [...m, ...out].slice(0, 4))
    out.filter((o) => !o.error && o.kind === 'photo').forEach((o) => {
      const reader = new FileReader()
      reader.onload = () => setMedia((m) => m.map((x) => x.id === o.id ? { ...x, dataUrl: String(reader.result) } : x))
      reader.readAsDataURL(out.find((f) => f.id === o.id) ? files[Array.from(files).findIndex((f) => f.name === o.name)] : files[0])
    })
  }
  const removeMedia = (id: string) => setMedia((m) => m.filter((x) => x.id !== id))

  const wiz: Wizard = useMemo(() => ({ draft, set, media, addMedia, removeMedia, requestKey }), [draft, media, requestKey])

  return (
    <WizCtx.Provider value={wiz}>
      <div className="mx-auto min-h-dvh max-w-lg">
        <AnimatePresence initial={false} mode="wait">
          <Routes>
            <Route path="/" element={<Navigate to="type" replace />} />
            <Route path="/type" element={<StepType />} />
            <Route path="/location" element={<StepLocation />} />
            <Route path="/details" element={<StepDetails />} />
            <Route path="/impact" element={<StepImpact />} />
            <Route path="/evidence" element={<StepEvidence />} />
            <Route path="/review" element={<StepReview />} />
            <Route path="*" element={<Navigate to="/raise/type" replace />} />
          </Routes>
        </AnimatePresence>
      </div>
    </WizCtx.Provider>
  )
}

function StepShell({ title, children, footer, canNext, onNext, nextLabel }:
  { title: string; children: React.ReactNode; footer?: React.ReactNode; canNext: boolean; onNext: () => void; nextLabel?: string }) {
  const { t } = useT()
  const nav = useNavigate()
  return (
    <Fade className="flex min-h-dvh flex-col">
      <NavBar title={title} />
      <div className="flex-1 pb-32">{children}</div>
      <div className="safe-bottom fixed inset-x-0 bottom-0 mx-auto flex max-w-lg gap-3 px-5 pb-5 pt-3">
        <Button variant="outline" className="max-w-28 flex-none" onClick={() => nav(-1)}>{t('action.cancel')}</Button>
        <Button onClick={onNext} disabled={!canNext}>{nextLabel ?? t('action.next')}</Button>
      </div>
      {footer}
    </Fade>
  )
}

function StepType() {
  const { t, lang } = useT()
  const { draft, set } = useWiz()
  const nav = useNavigate()
  const [subOpen, setSubOpen] = useState(false)
  const cat = draft.categoryCode ? category(draft.categoryCode) : null
  return (
    <StepShell title={t('form.type')} canNext={!!draft.categoryCode}
      onNext={() => nav('/raise/location')}>
      <div className="hairline-t">
        {CATEGORIES.map((c) => (
          <OptionRow key={c.code} selected={draft.categoryCode === c.code}
            title={`${lang === 'hi' ? c.nameHi : c.nameEn}`}
            detail={c.letter}
            onClick={() => { set({ categoryCode: c.code, subtype: undefined }); setSubOpen(true) }} />
        ))}
      </div>
      {cat && subOpen && (
        <div className="px-5 pt-5">
          <p className="mb-2 text-[13px] font-medium text-muted">{t('form.subtype')}</p>
          <div className="flex flex-wrap gap-2">
            {(lang === 'hi' ? cat.subtypesHi : cat.subtypesEn).map((s) => (
              <button key={s} onClick={() => { set({ subtype: s }); setSubOpen(false) }}
                className={`rounded-full border px-3.5 py-1.5 text-[14px] ${draft.subtype === s ? 'border-fg bg-inverse text-inverse-fg' : 'border-line text-fg'}`}>
                {s}
              </button>
            ))}
          </div>
        </div>
      )}
    </StepShell>
  )
}

function StepLocation() {
  const { t, lang } = useT()
  const { draft, set } = useWiz()
  const nav = useNavigate()
  const building = BUILDINGS.find((b) => b.code === draft.location.building)
  const canNext = draft.location.outdoors ? true : !!draft.location.building && !!draft.location.room
  return (
    <StepShell title={t('form.location')} canNext={canNext} onNext={() => nav('/raise/details')}>
      <div className="space-y-1 pt-2">
        <Segmented label="outdoors" value={draft.location.outdoors ? 'out' : 'in'}
          onChange={(v) => set({ location: { ...draft.location, outdoors: v === 'out' } })}
          options={[{ value: 'in', label: 'In a building' }, { value: 'out', label: t('form.outdoors') }]} />
      </div>
      {!draft.location.outdoors ? (
        <>
          <Field label={t('form.building')}>
            <div className="flex flex-wrap gap-2">
              {BUILDINGS.map((b) => (
                <button key={b.code} onClick={() => set({ location: { ...draft.location, building: b.code } })}
                  className={`rounded-full border px-3.5 py-1.5 text-[14px] ${draft.location.building === b.code ? 'border-fg bg-inverse text-inverse-fg' : 'border-line'}`}>
                  {lang === 'hi' ? b.nameHi : b.nameEn}
                </button>
              ))}
            </div>
          </Field>
          {building && (
            <Field label={t('form.floor')}>
              <div className="flex flex-wrap gap-2">
                {['Ground', ...building.floors.filter((f) => f !== 'Ground')].map((f) => (
                  <button key={f} onClick={() => set({ location: { ...draft.location, floor: f } })}
                    className={`token rounded-full border px-3.5 py-1.5 text-[13.5px] ${draft.location.floor === f ? 'border-fg bg-inverse text-inverse-fg' : 'border-line'}`}>
                    {f}
                  </button>
                ))}
              </div>
            </Field>
          )}
          <Field label={t('form.room')}>
            <TextInput value={draft.location.room} onChange={(e) => set({ location: { ...draft.location, room: e.target.value } })} placeholder="203" inputMode="text" />
          </Field>
        </>
      ) : (
        <Field label={t('form.landmark')}>
          <TextInput value={draft.location.landmark ?? ''} onChange={(e) => set({ location: { ...draft.location, landmark: e.target.value } })} placeholder="Near the main gate" />
        </Field>
      )}
    </StepShell>
  )
}

function StepDetails() {
  const { t } = useT()
  const { draft, set } = useWiz()
  const nav = useNavigate()
  return (
    <StepShell title={t('form.type')} canNext={draft.title.trim().length >= 4} onNext={() => nav('/raise/impact')}>
      <Field label={t('form.title')} hint={`${draft.title.length}/120`}>
        <TextInput maxLength={120} value={draft.title} onChange={(e) => set({ title: e.target.value })}
          placeholder="Broken chair in lecture room" />
      </Field>
      <Field label={t('form.description')} hint={`${draft.description.length}/2000`}>
        <textarea maxLength={2000} value={draft.description} onChange={(e) => set({ description: e.target.value })} rows={6}
          placeholder="What failed, when it started, and how it affects classes."
          className="w-full resize-none rounded-md border border-line bg-surface px-4 py-3 text-[16px] leading-6 placeholder:text-muted/60 focus:border-fg/40" />
      </Field>
    </StepShell>
  )
}

function StepImpact() {
  const { t } = useT()
  const { draft, set } = useWiz()
  const nav = useNavigate()
  const impacts: { v: Ticket['impact']; k: TKey }[] = [
    { v: 'safety', k: 'form.impact.safety' },
    { v: 'class_interrupted', k: 'form.impact.class' },
    { v: 'multiple_areas', k: 'form.impact.multiple' },
    { v: 'routine', k: 'form.impact.routine' },
  ]
  return (
    <StepShell title={t('form.impact')} canNext onNext={() => nav('/raise/evidence')}>
      <div className="hairline-t">
        {impacts.map(({ v, k }) => (
          <OptionRow key={v} selected={draft.impact === v} title={t(k)} onClick={() => set({ impact: v })} />
        ))}
      </div>
      {draft.impact === 'safety' && (
        <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mx-5 mt-4 rounded-md border border-fg/30 px-4 py-3 text-[13.5px] leading-5">
          If this is an electrical fault, fire, or major flooding — call the campus emergency number first. Register the issue here after you are safe.
        </motion.p>
      )}
      <Field label={t('form.access')} hint="optional">
        <TextInput value={draft.accessNote ?? ''} onChange={(e) => set({ accessNote: e.target.value })} placeholder="After 4 pm, caretaker on floor" />
      </Field>
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
    <StepShell title={t('form.evidence')} canNext onNext={() => nav('/raise/review')}>
      <p className="px-5 text-[13px] text-muted">{t('form.evidenceHint')}</p>
      <div className="grid grid-cols-2 gap-3 px-5 pt-4">
        <button onClick={() => cameraRef.current?.click()}
          className="flex h-24 items-center justify-center gap-2 rounded-md border border-line text-[14px] font-medium active:bg-subtle">
          <Camera size={17} /> {t('form.camera')}
        </button>
        <button onClick={() => fileRef.current?.click()}
          className="flex h-24 items-center justify-center gap-2 rounded-md border border-line text-[14px] font-medium active:bg-subtle">
          <Paperclip size={17} /> {t('form.upload')}
        </button>
        <input ref={cameraRef} type="file" accept="image/*,video/*" capture="environment" hidden onChange={(e) => e.target.files && addMedia(e.target.files)} />
        <input ref={fileRef} type="file" accept="image/*,video/*" multiple hidden onChange={(e) => e.target.files && addMedia(e.target.files)} />
      </div>
      {media.length > 0 && (
        <ul className="mt-4 space-y-2 px-5">
          {media.map((m) => (
            <li key={m.id} className="flex items-center gap-3 rounded-md border border-line px-3 py-2.5">
              {m.dataUrl ? <img src={m.dataUrl} alt="" className="h-10 w-10 rounded object-cover" /> : <Paperclip size={15} className="text-muted" />}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px]">{m.name}</span>
                <span className="token block text-[11.5px] text-muted">{m.error ?? `${(m.sizeBytes / 1024 / 1024).toFixed(1)} MB`}</span>
              </span>
              <button aria-label={t('action.remove')} onClick={() => removeMedia(m.id)} className="flex h-8 w-8 items-center justify-center rounded-full text-muted active:bg-subtle"><X size={15} /></button>
            </li>
          ))}
        </ul>
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
      const ticket = await submitAsFaculty(draft, requestKey)
      localStorage.removeItem(DRAFTS_KEY)
      const failed = media.filter((m) => m.error)
      for (const m of media.filter((x) => !x.error)) {
        try { await api.attachMedia(ticket.id, m) } catch { /* evidence failure keeps the ticket */ }
      }
      if (failed.length) setError('Some files were too large and were not sent. Your ticket was created.')
      nav(`/receipt/${ticket.id}`, { replace: true })
    } catch (err) {
      setError(err instanceof HttpError ? err.message : 'Submission failed. Your draft is kept on this device.')
    } finally {
      setBusy(false)
    }
  }

  const loc = draft.location.outdoors
    ? `${t('form.outdoors')}${draft.location.landmark ? ' · ' + draft.location.landmark : ''}`
    : `${lang === 'hi' ? BUILDINGS.find((b) => b.code === draft.location.building)?.nameHi ?? draft.location.building : `Block ${draft.location.building}`} · ${draft.location.floor} · ${draft.location.room}`

  return (
    <StepShell title={t('form.review')} canNext={!busy} onNext={submit} nextLabel={t('action.submit')}>
      <AnimatePresence>
        {dups.length > 0 && (
          <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
            className="mx-5 mt-4 rounded-md border border-line px-4 py-3">
            <p className="text-[13px] font-medium">Similar report already open here</p>
            {dups.map((d) => <p key={d.id} className="token mt-1 text-[12.5px] text-muted">{d.token} · {d.title}</p>)}
            <p className="mt-1.5 text-[12.5px] text-muted">Continue only if the fault is different.</p>
          </motion.div>
        )}
      </AnimatePresence>
      <dl className="hairline-t mt-4">
        {[
          [t('form.type'), `${lang === 'hi' ? cat.nameHi : cat.nameEn}${draft.subtype ? ' · ' + draft.subtype : ''}`],
          [t('form.location'), loc],
          [t('form.title'), draft.title],
          [t('form.impact'), t(draft.impact === 'safety' ? 'form.impact.safety' : draft.impact === 'class_interrupted' ? 'form.impact.class' : draft.impact === 'multiple_areas' ? 'form.impact.multiple' : 'form.impact.routine')],
          [t('form.evidence'), `${media.length ? media.length : 'None'}`],
        ].map(([k, v]) => (
          <div key={k} className="flex justify-between gap-6 border-b border-line px-5 py-3.5">
            <dt className="w-32 flex-none text-[13px] text-muted">{k}</dt>
            <dd className="text-right text-[14.5px] font-medium">{v || '—'}</dd>
          </div>
        ))}
      </dl>
      {error && <p role="alert" className="mx-5 mt-4 rounded-md border border-fg/25 px-4 py-3 text-[13.5px] leading-5">{error}</p>}
      <p className="px-5 pt-4 text-[12.5px] leading-5 text-muted">Draft saved on this device until it is sent. A draft is not a ticket.</p>
    </StepShell>
  )
}

async function submitAsFaculty(draft: Draft, requestKey: string) {
  const user = (await import('../../lib/api')).api.restore()
  if (!user) throw new HttpError('unauthorized', 'Sign in again to send this report. Your draft is kept.')
  return api.createTicket(user, { ...draft, title: draft.title, description: draft.description }, requestKey)
}

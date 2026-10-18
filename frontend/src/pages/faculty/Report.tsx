import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Camera, ImagePlus, X } from 'lucide-react'
import { Alert, Button, Card, Checkbox, Chips, Field, Input, PageHeader, RadioList, Select, Stack, Textarea, errorMessage } from '../../components/ui'
import { api, HttpError } from '../../lib/api'
import { buildings, categories, category } from '../../lib/catalog'
import { PrepareError, checkVideo, preparePhoto } from '../../lib/images'
import { useT } from '../../lib/i18n'
import type { Draft, Impact, Status } from '../../lib/types'
import { uuid } from '../../lib/uuid'

const DRAFT_KEY = 'pcms.drafts'
const MAX_PHOTOS = 3
const MAX_VIDEOS = 1

interface Media { id: string; file: File; kind: 'photo' | 'video'; preview?: string; error?: string; state: 'ready' | 'preparing' | 'uploading' | 'sent' | 'failed' }

const emptyDraft = (): Draft => ({
  key: uuid(), savedAt: new Date().toISOString(), title: '', description: '', categoryCode: '',
  location: { building: '', floor: '', room: '' }, impact: 'routine',
})

function loadDraft(): Draft {
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? '[]') as Draft[]
    return d[0]?.key ? { ...emptyDraft(), ...d[0] } : emptyDraft()
  } catch { return emptyDraft() }
}

export default function Report() {
  const { t, lang } = useT()
  const nav = useNavigate()
  const [d, setD] = useState<Draft>(loadDraft)
  const [media, setMedia] = useState<Media[]>([])
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [ticketId, setTicketId] = useState<string | null>(null)
  const [dups, setDups] = useState<{ token: string; title: string; status: Status }[]>([])
  const [more, setMore] = useState(!!(d.accessNote || d.altContact))
  const camera = useRef<HTMLInputElement>(null)
  const picker = useRef<HTMLInputElement>(null)
  const mediaRef = useRef(media)
  mediaRef.current = media

  const cat = d.categoryCode ? category(d.categoryCode) : null
  const b = buildings().find((x) => x.code === d.location.building)
  const needsOther = !!cat && (d.subtype === 'Other' || cat.code === 'other')

  // Text-only draft on this device until it is sent (plan section 6).
  const set = (patch: Partial<Draft>) => setD((cur) => {
    const next = { ...cur, ...patch, savedAt: new Date().toISOString() }
    if (!ticketId) localStorage.setItem(DRAFT_KEY, JSON.stringify([next]))
    return next
  })
  const setLoc = (patch: Partial<Draft['location']>) => set({ location: { ...d.location, ...patch } })

  useEffect(() => () => { mediaRef.current.forEach((m) => m.preview && URL.revokeObjectURL(m.preview)) }, [])

  useEffect(() => {
    if (!d.categoryCode || (!d.location.outdoors && !(d.location.building && d.location.room.trim()))) return
    const id = setTimeout(() => api.findDuplicates(d.location, d.categoryCode).then(setDups).catch(() => setDups([])), 400)
    return () => clearTimeout(id)
  }, [d.categoryCode, d.location])

  async function addFiles(files: FileList | null) {
    if (!files) return
    setError(null)
    for (const f of Array.from(files)) {
      const kind = f.type.startsWith('video/') ? 'video' as const : 'photo' as const
      const ok = mediaRef.current.filter((m) => !m.error)
      if (kind === 'photo' && ok.filter((m) => m.kind === 'photo').length >= MAX_PHOTOS) { setError('You can add up to 3 photos.'); continue }
      if (kind === 'video' && ok.filter((m) => m.kind === 'video').length >= MAX_VIDEOS) { setError('You can add 1 video.'); continue }
      const id = uuid()
      if (kind === 'video') {
        const bad = checkVideo(f)
        setMedia((m) => [...m, { id, file: f, kind, error: bad ?? undefined, state: 'ready' }])
        continue
      }
      setMedia((m) => [...m, { id, file: f, kind, state: 'preparing' }])
      try {
        const prepared = await preparePhoto(f)
        setMedia((m) => m.map((x) => x.id === id ? { ...x, file: prepared, preview: URL.createObjectURL(prepared), state: 'ready' } : x))
      } catch (e) {
        setMedia((m) => m.map((x) => x.id === id ? { ...x, error: e instanceof PrepareError ? e.message : 'Could not read this photo.', state: 'ready' } : x))
      }
    }
  }

  function removeMedia(id: string) {
    setMedia((m) => {
      const gone = m.find((x) => x.id === id)
      if (gone?.preview) URL.revokeObjectURL(gone.preview)
      return m.filter((x) => x.id !== id)
    })
  }

  function validate(): boolean {
    const e: Record<string, string> = {}
    if (!d.categoryCode) e.categoryCode = 'Choose what needs fixing.'
    if (needsOther && (d.otherDetail ?? '').trim().length < 3) e.otherDetail = 'Say what it is.'
    if (d.location.outdoors) { if (!d.location.landmark?.trim()) e.location = 'Give a nearby landmark.' }
    else if (!d.location.building || !d.location.floor || !d.location.room.trim()) e.location = 'Choose the building and floor, and give the room.'
    if (d.title.trim().length < 4) e.title = 'Write a short title (at least 4 letters).'
    setErrors(e)
    return Object.keys(e).length === 0
  }

  async function submit(ev: React.FormEvent) {
    ev.preventDefault()
    setError(null)
    if (!ticketId && !validate()) { setError('Please fix the highlighted fields.'); return }
    if (media.some((m) => m.state === 'preparing')) { setError('Wait for the photos to finish preparing.'); return }
    setBusy(true)
    try {
      let id = ticketId
      if (!id) {
        // Text first; the token exists only after the server commits (plan section 6).
        id = (await api.createTicket(d, d.key)).id
        setTicketId(id)
        localStorage.removeItem(DRAFT_KEY)
      }
      let failed = 0
      for (const m of media.filter((x) => !x.error && x.state !== 'sent')) {
        setMedia((ms) => ms.map((x) => x.id === m.id ? { ...x, state: 'uploading' } : x))
        try {
          await api.uploadAttachment(id, m.file)
          setMedia((ms) => ms.map((x) => x.id === m.id ? { ...x, state: 'sent' } : x))
        } catch (e) {
          failed++
          setMedia((ms) => ms.map((x) => x.id === m.id ? { ...x, state: 'failed', error: errorMessage(e) } : x))
        }
      }
      if (failed) { setError(`Your report was sent, but ${failed} file(s) did not upload. Retry, or continue without them.`); return }
      nav(`/receipt/${id}`, { replace: true })
    } catch (e) {
      if (e instanceof HttpError && e.fieldErrors) setErrors(e.fieldErrors)
      setError(e instanceof HttpError && e.code === 'idempotency_conflict'
        ? 'This draft was already sent with different details. Check My tickets.'
        : `${errorMessage(e)} Your draft is kept on this device.`)
    } finally {
      setBusy(false)
    }
  }

  const impacts = useMemo(() => (['safety', 'class_interrupted', 'multiple_areas', 'routine'] as Impact[])
    .map((v) => ({ value: v, label: t(`impact.${v}`) })), [t])

  return (
    <form onSubmit={submit} noValidate>
      <Stack className="mx-auto max-w-2xl">
        <PageHeader title={t('form.page')} subtitle={t('home.subtitle')} />
        {ticketId && <Alert tone="ok">Report saved. Finish uploading the photos below, or continue.</Alert>}

        <Card title={t('form.type')}>
          <Stack>
            <Chips label={t('form.type')} invalid={!!errors.categoryCode} value={d.categoryCode}
              onChange={(code) => set({ categoryCode: code, subtype: undefined, otherDetail: undefined })}
              options={categories().map((c) => ({ value: c.code, label: lang === 'hi' ? c.nameHi : c.nameEn }))} />
            {errors.categoryCode && <p role="alert" className="text-[13px] text-bad">{errors.categoryCode}</p>}
            {cat && cat.code !== 'other' && cat.subtypesEn.length > 0 && (
              <div>
                <p className="mb-1.5 text-[14px] font-medium">{t('form.subtype')}</p>
                <Chips label={t('form.subtype')} value={d.subtype}
                  onChange={(s) => set({ subtype: s, otherDetail: s === 'Other' ? d.otherDetail : undefined })}
                  options={cat.subtypesEn.map((s, i) => ({ value: s, label: lang === 'hi' ? cat.subtypesHi[i] ?? s : s }))} />
              </div>
            )}
            {needsOther && (
              <Field label={t('form.otherWhat')} hint={t('form.otherHint')} error={errors.otherDetail}>
                {(id, desc) => <Input id={id} aria-describedby={desc} invalid={!!errors.otherDetail} maxLength={70}
                  value={d.otherDetail ?? ''} onChange={(e) => set({ otherDetail: e.target.value })} />}
              </Field>
            )}
          </Stack>
        </Card>

        <Card title={t('form.where')}>
          <Stack>
            <Checkbox label={t('form.outdoors')} checked={!!d.location.outdoors} onChange={(v) => setLoc({ outdoors: v })} />
            {!d.location.outdoors ? (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={t('form.building')}>
                  {(id) => (
                    <Select id={id} value={d.location.building} invalid={!!errors.location && !d.location.building}
                      onChange={(e) => setLoc({ building: e.target.value, floor: '' })}>
                      <option value="">{t('form.chooseBuilding')}</option>
                      {buildings().map((x) => <option key={x.code} value={x.code}>{lang === 'hi' ? x.nameHi : x.nameEn}</option>)}
                    </Select>
                  )}
                </Field>
                <Field label={t('form.floor')}>
                  {(id) => (
                    <Select id={id} value={d.location.floor} disabled={!b} invalid={!!errors.location && !d.location.floor}
                      onChange={(e) => setLoc({ floor: e.target.value })}>
                      <option value="">{t('form.chooseFloor')}</option>
                      {b?.floors.map((f) => <option key={f} value={f}>{f === 'Ground' ? 'Ground floor' : `Floor ${f}`}</option>)}
                    </Select>
                  )}
                </Field>
                <Field label={t('form.room')}>
                  {(id) => <Input id={id} value={d.location.room} maxLength={60} placeholder="e.g. 203, Lab 2, Staff room"
                    invalid={!!errors.location && !d.location.room.trim()} onChange={(e) => setLoc({ room: e.target.value })} />}
                </Field>
                <Field label={t('form.landmark')} optional>
                  {(id) => <Input id={id} value={d.location.landmark ?? ''} maxLength={120} onChange={(e) => setLoc({ landmark: e.target.value })} />}
                </Field>
              </div>
            ) : (
              <Field label={t('form.landmark')}>
                {(id) => <Input id={id} value={d.location.landmark ?? ''} maxLength={120} placeholder="e.g. Near the main gate"
                  invalid={!!errors.location} onChange={(e) => setLoc({ landmark: e.target.value })} />}
              </Field>
            )}
            {errors.location && <p role="alert" className="text-[13px] text-bad">{errors.location}</p>}
          </Stack>
        </Card>

        {dups.length > 0 && !ticketId && (
          <Alert tone="warn" title={t('form.dupTitle')}>
            {dups.map((x) => <span key={x.token} className="block"><span className="token font-semibold">{x.token}</span> {x.title}</span>)}
            <span className="mt-1 block text-muted">{t('form.dupBody')}</span>
          </Alert>
        )}

        <Card title="What is wrong?">
          <Stack>
            <Field label={t('form.titleLabel')} error={errors.title} hint={`${d.title.length}/120`}>
              {(id, desc) => <Input id={id} aria-describedby={desc} invalid={!!errors.title} maxLength={120} value={d.title}
                placeholder="e.g. Ceiling fan not working" onChange={(e) => set({ title: e.target.value })} />}
            </Field>
            <Field label={t('form.details')} optional hint={t('form.detailsHint')}>
              {(id, desc) => <Textarea id={id} aria-describedby={desc} rows={4} maxLength={2000} value={d.description}
                onChange={(e) => set({ description: e.target.value })} />}
            </Field>
            <div>
              <p className="mb-1.5 text-[14px] font-medium">{t('form.impact')}</p>
              <RadioList name="impact" value={d.impact} onChange={(v) => set({ impact: v })} options={impacts} />
              {d.impact === 'safety' && <div className="mt-3"><Alert tone="bad">{t('form.safetyWarning')}</Alert></div>}
            </div>
            {!more
              ? <button type="button" className="text-left text-[14px] text-accent" onClick={() => setMore(true)}>+ {t('form.more')}</button>
              : (
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label={t('form.access')} optional>
                    {(id) => <Input id={id} maxLength={200} value={d.accessNote ?? ''} placeholder="e.g. After 4 pm" onChange={(e) => set({ accessNote: e.target.value })} />}
                  </Field>
                  <Field label={t('form.altContact')} optional>
                    {(id) => <Input id={id} maxLength={120} value={d.altContact ?? ''} placeholder="e.g. Lab assistant, ext 214" onChange={(e) => set({ altContact: e.target.value })} />}
                  </Field>
                </div>
              )}
          </Stack>
        </Card>

        <Card title={t('form.photos')}>
          <p className="mb-3 text-[13.5px] text-muted">{t('form.photosHint')}</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => camera.current?.click()}><Camera size={17} /> {t('form.takePhoto')}</Button>
            <Button variant="secondary" onClick={() => picker.current?.click()}><ImagePlus size={17} /> {t('form.choosePhoto')}</Button>
          </div>
          <input ref={camera} type="file" accept="image/*" capture="environment" hidden onChange={(e) => { void addFiles(e.target.files); e.target.value = '' }} />
          <input ref={picker} type="file" accept="image/*,video/mp4,video/webm" multiple hidden onChange={(e) => { void addFiles(e.target.files); e.target.value = '' }} />
          {media.length > 0 && (
            <ul className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
              {media.map((m) => (
                <li key={m.id} className="relative overflow-hidden rounded-md border border-line bg-subtle">
                  {m.preview ? <img src={m.preview} alt="" className="aspect-square w-full object-cover" />
                    : <div className="flex aspect-square items-center justify-center p-2 text-center text-[12px] text-muted">{m.file.name}</div>}
                  <p className={`px-2 py-1 text-[12px] ${m.error ? 'text-bad' : 'text-muted'}`}>
                    {m.error ?? { ready: 'Ready', preparing: 'Preparing...', uploading: 'Uploading...', sent: 'Sent', failed: 'Failed' }[m.state]}
                  </p>
                  {m.state !== 'uploading' && m.state !== 'sent' && (
                    <button type="button" aria-label="Remove" onClick={() => removeMedia(m.id)}
                      className="absolute right-1 top-1 flex h-8 w-8 items-center justify-center rounded-full bg-black/60 text-white"><X size={16} /></button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>

        {error && <Alert tone="bad">{error}</Alert>}
        <div className="flex flex-col-reverse gap-2 pb-2 sm:flex-row sm:justify-end">
          {ticketId && <Button variant="secondary" onClick={() => nav(`/receipt/${ticketId}`, { replace: true })}>Continue without files</Button>}
          <Button type="submit" loading={busy} className="sm:min-w-48">{ticketId ? 'Retry uploads' : t('form.submit')}</Button>
        </div>
        {!ticketId && <p className="pb-6 text-center text-[13px] text-muted">{t('form.draftNote')}</p>}
      </Stack>
    </form>
  )
}

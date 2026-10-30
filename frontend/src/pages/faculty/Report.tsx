import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, Building2, Camera, ImagePlus, Monitor, Wrench, X } from 'lucide-react'
import { useAuth } from '../../App'
import { Gallery, floorLabel } from '../../components/ticket'
import { Alert, Button, Card, Checkbox, Field, Input, PageHeader, RadioList, Select, Spinner, Stack, Textarea, errorMessage } from '../../components/ui'
import { api, HttpError } from '../../lib/api'
import { buildingDepartments, buildingName, buildings, categories, category, categoryName, categoryParts } from '../../lib/catalog'
import { PrepareError, checkVideo, preparePhoto } from '../../lib/images'
import { useT } from '../../lib/i18n'
import { TERMINAL, type Draft, type Impact, type Status, type Ticket } from '../../lib/types'
import { uuid } from '../../lib/uuid'

const DRAFT_KEY = 'pcms.drafts'
const MAX_PHOTOS = 3
const MAX_VIDEOS = 1
const CUSTOM_BUILDING = 'CUSTOM'
const EDITABLE: Status[] = ['Submitted', 'Triaged']

const CATEGORY_ICON = { it_services: Monitor, civil: Building2, mechanical: Wrench }

interface Media { id: string; file: File; kind: 'photo' | 'video'; preview?: string; error?: string; state: 'ready' | 'preparing' | 'uploading' | 'sent' | 'failed' }

const emptyDraft = (): Draft => ({
  key: uuid(), savedAt: new Date().toISOString(), title: '', description: '', categoryCode: '',
  location: { building: '', department: '', floor: '', room: '' }, impact: 'routine',
})

function loadDraft(): Draft {
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? '[]') as Draft[]
    const saved = d[0]
    if (!saved?.key) return emptyDraft()
    const empty = emptyDraft()
    return { ...empty, ...saved, location: { ...empty.location, ...saved.location } }
  } catch { return emptyDraft() }
}

function draftFromTicket(t: Ticket): Draft {
  const c = category(t.categoryCode)
  let subtype = t.subtype ?? undefined
  let otherDetail: string | undefined
  if (subtype) {
    const base = c.subtypesEn.find((s) => subtype?.startsWith(`${s}: `))
    if (base) {
      otherDetail = subtype.slice(base.length + 2)
      subtype = base
    } else if (subtype.startsWith('Other: ')) {
      otherDetail = subtype.slice(7)
      subtype = 'Other'
    }
  }
  return {
    key: t.id,
    savedAt: t.updatedAt,
    title: t.title,
    description: t.description,
    categoryCode: t.categoryCode,
    subtype,
    otherDetail,
    location: {
      building: t.location.building || CUSTOM_BUILDING,
      customLocation: t.location.customLocation ?? '',
      department: t.location.department ?? '',
      floor: t.location.floor,
      room: t.location.room,
      outdoors: t.location.outdoors,
      landmark: t.location.landmark ?? '',
    },
    impact: t.impact,
    accessNote: t.accessNote ?? undefined,
    altContact: t.altContact ?? undefined,
  }
}

function editProblem(ticket: Ticket, t: ReturnType<typeof useT>['t']): string | null {
  if (TERMINAL.includes(ticket.status)) return t('form.editClosed')
  if (!EDITABLE.includes(ticket.status)) return t('form.editStarted', { status: t(`status.${ticket.status}`) })
  return null
}

export default function Report() {
  const { id } = useParams()
  const editing = !!id
  const { user } = useAuth()
  const { t, lang } = useT()
  const nav = useNavigate()
  const [d, setD] = useState<Draft>(() => (editing ? emptyDraft() : loadDraft()))
  const [media, setMedia] = useState<Media[]>([])
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(editing)
  const [editTicket, setEditTicket] = useState<Ticket | null>(null)
  const [unavailable, setUnavailable] = useState<string | null>(null)
  const [ticketId, setTicketId] = useState<string | null>(null)
  const [dups, setDups] = useState<{ token: string; title: string; status: Status }[]>([])
  const [more, setMore] = useState(!!(d.accessNote || d.altContact))
  const camera = useRef<HTMLInputElement>(null)
  const picker = useRef<HTMLInputElement>(null)
  const mediaRef = useRef(media)
  mediaRef.current = media

  const cat = d.categoryCode ? category(d.categoryCode) : null
  const b = buildings().find((x) => x.code === d.location.building)
  const isCustom = d.location.building === CUSTOM_BUILDING
  const departmentOptions = b ? buildingDepartments(b, lang) : []
  const departmentLabel = b?.code === 'HOSTEL' ? t('form.hostelSection') : t('form.department')
  const sub = (d.subtype ?? '').toLowerCase()
  const needsOther = !!cat && (sub === 'other' || sub.startsWith('other ') || (cat.code === 'other' && !d.subtype))

  useEffect(() => {
    if (!id) return
    let alive = true
    setLoading(true)
    setUnavailable(null)
    api.getTicket(id).then((ticket) => {
      if (!alive) return
      if (!ticket) {
        setUnavailable(t('form.notFound'))
        setLoading(false)
        return
      }
      setEditTicket(ticket)
      setD(draftFromTicket(ticket))
      setMore(!!(ticket.accessNote || ticket.altContact))
      if (ticket.reporterId !== user?.id) setUnavailable(t('form.onlyReporter'))
      else setUnavailable(editProblem(ticket, t))
      setLoading(false)
    }).catch((e) => {
      if (!alive) return
      setUnavailable(errorMessage(e))
      setLoading(false)
    })
    return () => { alive = false }
  }, [id, user?.id, t])

  // Text-only draft on this device until it is sent (plan section 6).
  const set = (patch: Partial<Draft>) => setD((cur) => {
    const next = { ...cur, ...patch, savedAt: new Date().toISOString() }
    if (!editing && !ticketId) localStorage.setItem(DRAFT_KEY, JSON.stringify([next]))
    return next
  })
  const setLoc = (patch: Partial<Draft['location']>) => set({ location: { ...d.location, ...patch } })

  useEffect(() => () => { mediaRef.current.forEach((m) => m.preview && URL.revokeObjectURL(m.preview)) }, [])

  useEffect(() => {
    if (editing || !d.categoryCode || d.location.building === CUSTOM_BUILDING
      || (!d.location.outdoors && !(d.location.building && d.location.room.trim()))) return
    const id = setTimeout(() => api.findDuplicates(d.location, d.categoryCode).then(setDups).catch(() => setDups([])), 400)
    return () => clearTimeout(id)
  }, [editing, d.categoryCode, d.location])

  async function addFiles(files: FileList | null) {
    if (!files) return
    setError(null)
    for (const f of Array.from(files)) {
      const kind = f.type.startsWith('video/') ? 'video' as const : 'photo' as const
      const ok = mediaRef.current.filter((m) => !m.error)
      if (kind === 'photo' && ok.filter((m) => m.kind === 'photo').length >= MAX_PHOTOS) { setError(t('form.tooManyPhotos')); continue }
      if (kind === 'video' && ok.filter((m) => m.kind === 'video').length >= MAX_VIDEOS) { setError(t('form.oneVideo')); continue }
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
        setMedia((m) => m.map((x) => x.id === id ? { ...x, error: e instanceof PrepareError ? e.message : t('form.photoReadError'), state: 'ready' } : x))
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
    if (!d.categoryCode) e.categoryCode = t('form.chooseCategory')
    else if (cat && cat.subtypesEn.length > 0 && !d.subtype && cat.code !== 'other') e.subtype = t('form.chooseIssue')
    if (needsOther && (d.otherDetail ?? '').trim().length < 3) e.otherDetail = t('form.otherHint')
    const department = (d.location.department ?? '').trim()
    if (!d.location.building) {
      e.location = t('form.chooseBuilding')
    } else if (isCustom) {
      if ((d.location.customLocation ?? '').trim().length < 3) e.location = t('form.customLocationHint')
      else if (!d.location.outdoors && department.length < 2) e.location = t('form.departmentRequired')
      else if (d.location.outdoors) { if (!d.location.landmark?.trim()) e.location = t('form.landmarkRequired') }
      else if (!d.location.floor.trim() || !d.location.room.trim()) e.location = t('form.floorRoomRequired')
    } else if (!b) {
      e.location = t('form.chooseBuilding')
    } else if (departmentOptions.length > 0 && !department) {
      e.location = t('form.chooseDepartmentBuilding')
    } else if (d.location.outdoors) {
      if (!d.location.landmark?.trim()) e.location = t('form.landmarkRequired')
    } else if (!d.location.floor || !d.location.room.trim()) {
      e.location = t('form.chooseFloorRoom')
    }
    if (d.title.trim().length < 4) e.title = t('form.titleRequired')
    setErrors(e)
    return Object.keys(e).length === 0
  }

  async function submit(ev: React.FormEvent) {
    ev.preventDefault()
    setError(null)
    if (unavailable) return
    if (!validate()) { setError(t('form.fixFields')); return }
    if (media.some((m) => m.state === 'preparing')) { setError(t('form.waitPreparing')); return }
    setBusy(true)
    try {
      if (editing) {
        if (!editTicket) return
        const updated = await api.updateTicket(editTicket, d)
        nav(`/t/${updated.id}`, { replace: true })
        return
      }
      let id = ticketId
      if (!id) {
        // Text first; the token exists only after the server commits (plan section 6).
        id = (await api.createTicket(d, d.key)).id
        setTicketId(id)
        localStorage.removeItem(DRAFT_KEY)
      }
      let failed = 0
      for (const m of media.filter((x) => x.state === 'failed' || (x.state === 'ready' && !x.error))) {
        setMedia((ms) => ms.map((x) => x.id === m.id ? { ...x, state: 'uploading', error: undefined } : x))
        try {
          await api.uploadAttachment(id, m.file)
          setMedia((ms) => ms.map((x) => x.id === m.id ? { ...x, state: 'sent', error: undefined } : x))
        } catch (e) {
          failed++
          setMedia((ms) => ms.map((x) => x.id === m.id ? { ...x, state: 'failed', error: errorMessage(e) } : x))
        }
      }
      if (failed) { setError(t('form.uploadFailed', { count: failed })); return }
      nav(`/receipt/${id}`, { replace: true })
    } catch (e) {
      if (e instanceof HttpError && e.fieldErrors) setErrors(e.fieldErrors)
      if (e instanceof HttpError && e.code === 'stale_version') {
        setError(t('form.stale'))
      } else if (e instanceof HttpError && e.code === 'ticket_not_editable') {
        setUnavailable(errorMessage(e))
      } else {
        setError(e instanceof HttpError && e.code === 'idempotency_conflict'
          ? t('form.idempotency')
          : `${errorMessage(e)} ${editing ? '' : t('form.draftKept')}`)
      }
    } finally {
      setBusy(false)
    }
  }

  const impacts = useMemo(() => (['safety', 'class_interrupted', 'multiple_areas', 'routine'] as Impact[])
    .map((v) => ({ value: v, label: t(`impact.${v}`) })), [t])

  if (loading) return <Spinner />
  if (editing && unavailable) {
    return (
      <Stack className="mx-auto max-w-2xl">
        <PageHeader title={t('form.editPage')} subtitle={editTicket?.token} />
        <Alert tone="warn" title={t('form.editingUnavailable')}>{unavailable}</Alert>
        <Button variant="secondary" className="self-start" onClick={() => nav(id ? `/t/${id}` : '/tickets')}>
          <ArrowLeft size={16} /> {t('form.backToReport')}
        </Button>
      </Stack>
    )
  }

  return (
    <form onSubmit={submit} noValidate>
      <Stack className="mx-auto max-w-2xl">
        <PageHeader title={editing ? t('form.editPage') : t('form.page')} subtitle={editing ? editTicket?.token : t('home.subtitle')} />
        {ticketId && <Alert tone="ok">{t('form.reportSaved')}</Alert>}

        <Card title={t('form.type')}>
          <Stack>
            <div role="radiogroup" aria-label={t('form.type')} className="grid gap-3 sm:grid-cols-3">
              {categories().map((c) => {
                const Icon = CATEGORY_ICON[c.code as keyof typeof CATEGORY_ICON] ?? Wrench
                const selected = d.categoryCode === c.code
                return (
                  <button key={c.code} type="button" role="radio" aria-checked={selected}
                    onClick={() => set({ categoryCode: c.code, subtype: undefined, otherDetail: undefined })}
                    className={`flex min-h-28 flex-col items-start gap-2 rounded-lg border p-4 text-left transition ${selected ? 'border-accent bg-accent-soft ring-2 ring-accent/25' : 'border-line bg-surface hover:bg-subtle'}`}>
                    <span className={`flex h-9 w-9 items-center justify-center rounded-md ${selected ? 'bg-accent text-accent-fg' : 'bg-subtle text-accent'}`}>
                      <Icon size={19} aria-hidden />
                    </span>
                    <span className="text-[15px] font-semibold">{categoryName(c, lang)}</span>
                    <span className="text-[12.5px] text-muted">{t('form.optionsCount', { count: c.subtypesEn.length })}</span>
                  </button>
                )
              })}
            </div>
            {errors.categoryCode && <p role="alert" className="text-[13px] text-bad">{errors.categoryCode}</p>}
            {cat && cat.subtypesEn.length > 0 && (
              <Field label={t('form.subtype')} error={errors.subtype}>
                {(fieldId, desc) => (
                  <Select id={fieldId} aria-describedby={desc} value={d.subtype ?? ''} invalid={!!errors.subtype}
                    onChange={(e) => {
                      const s = e.target.value || undefined
                      const other = !!s && (s.toLowerCase() === 'other' || s.toLowerCase().startsWith('other '))
                      set({ subtype: s, otherDetail: other ? d.otherDetail : undefined })
                    }}>
                    <option value="">{t('form.chooseIssue')}</option>
                    {categoryParts(cat, lang).map((part) => <option key={part.value} value={part.value}>{part.label}</option>)}
                  </Select>
                )}
              </Field>
            )}
            {needsOther && (
              <Field label={t('form.otherWhat')} hint={t('form.otherHint')} error={errors.otherDetail}>
                {(fieldId, desc) => <Input id={fieldId} aria-describedby={desc} invalid={!!errors.otherDetail} maxLength={120}
                  value={d.otherDetail ?? ''} onChange={(e) => set({ otherDetail: e.target.value })} />}
              </Field>
            )}
          </Stack>
        </Card>

        <Card title={t('form.where')}>
          <Stack>
            <Checkbox label={t('form.outdoors')} checked={!!d.location.outdoors} onChange={(v) => setLoc({ outdoors: v })} />
            <Field label={t('form.building')}>
              {(fieldId) => (
                <Select id={fieldId} value={d.location.building} invalid={!!errors.location && !d.location.building}
                  onChange={(e) => setLoc({ building: e.target.value, department: '', floor: '', room: '', customLocation: '' })}>
                  <option value="">{t('form.chooseBuilding')}</option>
                  {buildings().map((x) => <option key={x.code} value={x.code}>{buildingName(x, lang)}</option>)}
                  <option value={CUSTOM_BUILDING}>{t('form.customLocation')}</option>
                </Select>
              )}
            </Field>
            {!isCustom && b && (
              departmentOptions.length > 0 ? (
                <Field label={departmentLabel}>
                  {(fieldId) => (
                    <Select id={fieldId} value={d.location.department ?? ''} invalid={!!errors.location && !d.location.department}
                      onChange={(e) => setLoc({ department: e.target.value })}>
                      <option value="">{t('form.chooseDepartment')}</option>
                      {departmentOptions.map((department) => <option key={department.value} value={department.value}>{department.label}</option>)}
                    </Select>
                  )}
                </Field>
              ) : (
                <p className="text-[13px] text-muted">{t('form.noDepartments')}</p>
              )
            )}
            {isCustom && (
              <>
                <Field label={t('form.customBuilding')} hint={t('form.customLocationHint')}>
                  {(fieldId, desc) => <Input id={fieldId} aria-describedby={desc} value={d.location.customLocation ?? ''} maxLength={120}
                    placeholder={t('form.customLocationHint')} invalid={!!errors.location} onChange={(e) => setLoc({ customLocation: e.target.value })} />}
                </Field>
                <Field label={t('form.department')} optional={!!d.location.outdoors} hint={t('form.departmentHint')}>
                  {(fieldId, desc) => <Input id={fieldId} aria-describedby={desc} value={d.location.department ?? ''} maxLength={120}
                    placeholder={t('form.departmentHint')} onChange={(e) => setLoc({ department: e.target.value })} />}
                </Field>
              </>
            )}
            {!d.location.outdoors ? (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={t('form.floor')}>
                  {(fieldId) => isCustom ? (
                    <Input id={fieldId} value={d.location.floor} maxLength={20} placeholder={t('form.floorPlaceholder')}
                      invalid={!!errors.location && !d.location.floor.trim()} onChange={(e) => setLoc({ floor: e.target.value })} />
                  ) : (
                    <Select id={fieldId} value={d.location.floor} disabled={!b} invalid={!!errors.location && !d.location.floor}
                      onChange={(e) => setLoc({ floor: e.target.value })}>
                      <option value="">{t('form.chooseFloor')}</option>
                      {b?.floors.map((f) => <option key={f} value={f}>{floorLabel(f, t)}</option>)}
                    </Select>
                  )}
                </Field>
                <Field label={t('form.room')}>
                  {(fieldId) => <Input id={fieldId} value={d.location.room} maxLength={60} placeholder={t('form.roomPlaceholder')}
                    invalid={!!errors.location && !d.location.room.trim()} onChange={(e) => setLoc({ room: e.target.value })} />}
                </Field>
                <Field label={t('form.landmark')} optional>
                  {(fieldId) => <Input id={fieldId} value={d.location.landmark ?? ''} maxLength={120} onChange={(e) => setLoc({ landmark: e.target.value })} />}
                </Field>
              </div>
            ) : (
              <Field label={t('form.landmark')}>
                {(fieldId) => <Input id={fieldId} value={d.location.landmark ?? ''} maxLength={120} placeholder={t('form.landmarkPlaceholder')}
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

        <Card title={t('form.whatWrong')}>
          <Stack>
            <Field label={t('form.titleLabel')} error={errors.title} hint={`${d.title.length}/120`}>
              {(fieldId, desc) => <Input id={fieldId} aria-describedby={desc} invalid={!!errors.title} maxLength={120} value={d.title}
                placeholder={t('form.titlePlaceholder')} onChange={(e) => set({ title: e.target.value })} />}
            </Field>
            <Field label={t('form.details')} optional hint={t('form.detailsHint')}>
              {(fieldId, desc) => <Textarea id={fieldId} aria-describedby={desc} rows={4} maxLength={2000} value={d.description}
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
                    {(fieldId) => <Input id={fieldId} maxLength={200} value={d.accessNote ?? ''} placeholder={t('form.accessPlaceholder')} onChange={(e) => set({ accessNote: e.target.value })} />}
                  </Field>
                  <Field label={t('form.altContact')} optional>
                    {(fieldId) => <Input id={fieldId} maxLength={120} value={d.altContact ?? ''} placeholder={t('form.altContactPlaceholder')} onChange={(e) => set({ altContact: e.target.value })} />}
                  </Field>
                </div>
              )}
          </Stack>
        </Card>

        {editing && editTicket ? (
          <Card title={t('form.photos')}>
            <p className="mb-3 text-[13.5px] text-muted">{t('form.existingFiles')}</p>
            <Gallery ticket={editTicket} canAdd onChanged={async () => {
              const next = await api.getTicket(editTicket.id)
              if (next) setEditTicket(next)
            }} />
          </Card>
        ) : (
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
                      {m.error ?? {
                        ready: t('form.photoReady'), preparing: t('form.photoPreparing'), uploading: t('form.photoUploading'),
                        sent: t('form.photoSent'), failed: t('form.photoFailed'),
                      }[m.state]}
                    </p>
                    {m.state !== 'uploading' && m.state !== 'sent' && (
                      <button type="button" aria-label={t('action.remove')} onClick={() => removeMedia(m.id)}
                        className="absolute right-1 top-1 flex h-8 w-8 items-center justify-center rounded-full bg-black/60 text-white"><X size={16} /></button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}

        {error && <Alert tone="bad">{error}</Alert>}
        <div className="flex flex-col-reverse gap-2 pb-2 sm:flex-row sm:justify-end">
          {editing ? (
            <>
              <Button type="button" variant="secondary" onClick={() => nav(`/t/${id}`)}>{t('form.cancel')}</Button>
              <Button type="submit" loading={busy} className="sm:min-w-48">{t('form.saveChanges')}</Button>
            </>
          ) : (
            <>
              {ticketId && <Button variant="secondary" onClick={() => nav(`/receipt/${ticketId}`, { replace: true })}>{t('action.continueNoFiles')}</Button>}
              <Button type="submit" loading={busy} className="sm:min-w-48">{ticketId ? t('action.retryUploads') : t('form.submit')}</Button>
            </>
          )}
        </div>
        {!editing && !ticketId && <p className="pb-6 text-center text-[13px] text-muted">{t('form.draftNote')}</p>}
      </Stack>
    </form>
  )
}

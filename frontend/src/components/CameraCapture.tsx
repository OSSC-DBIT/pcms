/**
 * In-app camera for evidence: a live preview with Photo and Video modes.
 *
 * Photos are a frame from the preview saved as JPEG (no location metadata).
 * Videos use MediaRecorder at up to 720p, stop on their own after
 * MAX_VIDEO_SECONDS and carry no sound, so PCMS never asks for the microphone
 * (nginx's Permissions-Policy blocks it). The server re-checks and remuxes every file.
 *
 * getUserMedia needs HTTPS (or localhost). Where it is missing or the person
 * refuses access, the phone's own camera app is offered instead.
 */
import { clsx } from 'clsx'
import { Camera, Circle, RefreshCw, Square, Video } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useT } from '../lib/i18n'
import { MAX_VIDEO_BYTES, MAX_VIDEO_SECONDS } from '../lib/images'
import { Alert, Button, Dialog, Spinner } from './ui'

type Mode = 'photo' | 'video'

// Safari records MP4, Chrome and Firefox WebM; the first one the browser supports wins.
const RECORDER_TYPES = ['video/mp4;codecs=avc1', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4']
// About 9 MB for 30 seconds, well under the 20 MB limit.
const VIDEO_BITS_PER_SECOND = 2_500_000

const canUseCamera = () => typeof window !== 'undefined' && window.isSecureContext && !!navigator.mediaDevices?.getUserMedia

function recorderType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined
  return RECORDER_TYPES.find((type) => MediaRecorder.isTypeSupported(type))
}

const stamp = () => new Date().toISOString().replace(/\D/g, '').slice(0, 14)

/**
 * A "Camera" button. allowVideo=false limits it to photos (when the one video is already attached).
 * onFiles receives File objects exactly like a file input would.
 */
export function CameraButton({ onFiles, allowVideo = true, disabled }: { onFiles: (files: File[]) => void; allowVideo?: boolean; disabled?: boolean }) {
  const { t } = useT()
  const [open, setOpen] = useState(false)
  const system = useRef<HTMLInputElement>(null)
  const openSystemCamera = () => system.current?.click()
  return (
    <>
      <Button variant="secondary" disabled={disabled} onClick={() => (canUseCamera() ? setOpen(true) : openSystemCamera())}>
        <Camera size={17} /> {t('camera.open')}
      </Button>
      {/* Fallback: the phone's camera app. */}
      <input ref={system} type="file" hidden capture="environment" accept={allowVideo ? 'image/*,video/*' : 'image/*'}
        onChange={(e) => { if (e.target.files?.length) onFiles(Array.from(e.target.files)); e.target.value = '' }} />
      {open && (
        <CameraDialog allowVideo={allowVideo} onClose={() => setOpen(false)}
          onCapture={(f) => { setOpen(false); onFiles([f]) }}
          onUseSystem={() => { setOpen(false); openSystemCamera() }} />
      )}
    </>
  )
}

function CameraDialog({ allowVideo, onClose, onCapture, onUseSystem }: {
  allowVideo: boolean; onClose: () => void; onCapture: (f: File) => void; onUseSystem: () => void
}) {
  const { t } = useT()
  const [mode, setMode] = useState<Mode>('photo')
  const [facing, setFacing] = useState<'environment' | 'user'>('environment')
  const [state, setState] = useState<'starting' | 'live' | 'denied'>('starting')
  const [recording, setRecording] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const video = useRef<HTMLVideoElement>(null)
  const stream = useRef<MediaStream | null>(null)
  const recorder = useRef<MediaRecorder | null>(null)
  const canRecord = allowVideo && !!recorderType()

  // Start (or restart, after switching cameras) the preview; always release the camera.
  useEffect(() => {
    let cancelled = false
    navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } },
    }).then((s) => {
      if (cancelled) { s.getTracks().forEach((tr) => tr.stop()); return }
      stream.current = s
      const v = video.current
      if (!v) return
      // Enable the buttons only once a frame exists; an earlier tap would capture nothing.
      v.onloadeddata = () => { if (!cancelled) setState('live') }
      v.srcObject = s
      void v.play().catch(() => undefined)
    }).catch(() => { if (!cancelled) setState('denied') })
    return () => {
      cancelled = true
      if (recorder.current?.state === 'recording') { recorder.current.ondataavailable = null; recorder.current.onstop = null; recorder.current.stop() }
      recorder.current = null
      stream.current?.getTracks().forEach((tr) => tr.stop())
      stream.current = null
    }
  }, [facing])

  // Recording clock; stops on its own at the limit.
  useEffect(() => {
    if (!recording) return
    const started = Date.now()
    const id = setInterval(() => {
      const s = Math.floor((Date.now() - started) / 1000)
      setElapsed(s)
      if (s >= MAX_VIDEO_SECONDS) stopRecording()
    }, 250)
    return () => clearInterval(id)
  }, [recording])

  function takePhoto() {
    const v = video.current
    if (!v || !v.videoWidth) return
    const canvas = document.createElement('canvas')
    canvas.width = v.videoWidth
    canvas.height = v.videoHeight
    canvas.getContext('2d')?.drawImage(v, 0, 0)
    canvas.toBlob((blob) => {
      if (blob) onCapture(new File([blob], `photo-${stamp()}.jpg`, { type: 'image/jpeg', lastModified: Date.now() }))
    }, 'image/jpeg', 0.9)
  }

  function startRecording() {
    const type = recorderType()
    if (!stream.current || !type) return
    const chunks: Blob[] = []
    let size = 0
    const r = new MediaRecorder(stream.current, { mimeType: type, videoBitsPerSecond: VIDEO_BITS_PER_SECOND })
    r.ondataavailable = (e) => {
      if (!e.data.size) return
      chunks.push(e.data)
      size += e.data.size
      if (size >= MAX_VIDEO_BYTES * 0.95 && r.state === 'recording') r.stop()
    }
    r.onstop = () => {
      setRecording(false)
      const base = type.split(';')[0]
      const ext = base === 'video/mp4' ? 'mp4' : 'webm'
      if (chunks.length) onCapture(new File(chunks, `video-${stamp()}.${ext}`, { type: base, lastModified: Date.now() }))
    }
    recorder.current = r
    r.start(1000)
    setElapsed(0)
    setRecording(true)
  }

  function stopRecording() {
    if (recorder.current?.state === 'recording') recorder.current.stop()
  }

  return (
    <Dialog open onClose={() => { if (!recording) onClose() }} title={t('camera.open')} wide>
      {state === 'denied' ? (
        <div className="space-y-3">
          <Alert tone="warn">{t('camera.denied')}</Alert>
          <Button onClick={onUseSystem}><Camera size={17} /> {t('camera.useSystem')}</Button>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="relative overflow-hidden rounded-md bg-black">
            <video ref={video} playsInline muted autoPlay className="aspect-[3/4] max-h-[60vh] w-full object-contain sm:aspect-video" />
            {state === 'starting' && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-[13px] text-white">
                <Spinner /> {t('camera.starting')}
              </div>
            )}
            {recording && (
              <p role="status" className="absolute left-2 top-2 flex items-center gap-1.5 rounded-full bg-black/65 px-2.5 py-1 text-[12.5px] text-white">
                <span className="h-2 w-2 animate-pulse rounded-full bg-red-500" aria-hidden />
                {t('camera.recording', { elapsed, max: MAX_VIDEO_SECONDS })}
              </p>
            )}
          </div>

          {canRecord && (
            <div role="tablist" aria-label={t('camera.open')} className="flex justify-center gap-1 rounded-md bg-subtle p-1">
              {(['photo', 'video'] as const).map((m) => (
                <button key={m} type="button" role="tab" aria-selected={mode === m} disabled={recording} onClick={() => setMode(m)}
                  className={clsx('flex h-9 flex-1 items-center justify-center gap-1.5 rounded text-[14px]',
                    mode === m ? 'bg-surface font-medium shadow-sm' : 'text-muted')}>
                  {m === 'photo' ? <Camera size={16} aria-hidden /> : <Video size={16} aria-hidden />}
                  {t(m === 'photo' ? 'camera.photo' : 'camera.video')}
                </button>
              ))}
            </div>
          )}
          {mode === 'video' && !recording && <p className="text-center text-[12.5px] text-muted">{t('camera.videoLimit', { max: MAX_VIDEO_SECONDS })}</p>}

          <div className="flex items-center justify-center gap-3">
            <Button variant="secondary" disabled={recording || state !== 'live'} aria-label={t('camera.switch')}
              onClick={() => { setState('starting'); setFacing((f) => (f === 'environment' ? 'user' : 'environment')) }}>
              <RefreshCw size={17} />
            </Button>
            {mode === 'photo' && <Button disabled={state !== 'live'} onClick={takePhoto}><Circle size={17} /> {t('camera.capture')}</Button>}
            {mode === 'video' && !recording && <Button disabled={state !== 'live'} onClick={startRecording}><Video size={17} /> {t('camera.record')}</Button>}
            {mode === 'video' && recording && <Button variant="danger" onClick={stopRecording}><Square size={17} /> {t('camera.stop')}</Button>}
          </div>
        </div>
      )}
    </Dialog>
  )
}

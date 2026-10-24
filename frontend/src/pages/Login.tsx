import { useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { Link, useNavigate } from 'react-router-dom'
import { homeFor, useAuth } from '../App'
import { Footer, INSTITUTE } from '../components/Brand'
import InstallCard from '../components/InstallCard'
import { Alert, Button, Card, Checkbox, Field, Input, PasswordInput, errorMessage } from '../components/ui'
import { api } from '../lib/api'
import { useT } from '../lib/i18n'
import type { StepResult } from '../lib/types'

type Stage = { kind: 'credentials' } | { kind: 'change_password' | 'enrol_totp' | 'totp' | 'recovery'; step: StepResult }

export default function Login() {
  const { signedIn } = useAuth()
  const nav = useNavigate()
  const [stage, setStage] = useState<Stage>({ kind: 'credentials' })
  const password = useRef('') // held in memory only for the forced change

  async function advance(step: StepResult) {
    if (step.recoveryCodes?.length) return setStage({ kind: 'recovery', step })
    if (step.next === 'done') {
      password.current = ''
      await signedIn(step.user)
      nav(homeFor(step.user), { replace: true })
      return
    }
    setStage({ kind: step.next, step })
  }

  return (
    <main className="flex min-h-dvh flex-col">
      <div className="flex flex-1 items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm space-y-4">
        <div className="text-center">
          <Link to="/"><img src="/pwa-192x192.png" alt="PCMS home" width={56} height={56} className="mx-auto rounded-xl" /></Link>
          <h1 className="mt-3 text-[24px] font-semibold">PCMS</h1>
          <p className="text-[14px] text-muted">{INSTITUTE}</p>
        </div>
        <Card>
          {stage.kind === 'credentials' && <Credentials password={password} onStep={advance} />}
          {stage.kind === 'change_password' && <ChangePassword step={stage.step} current={password} onStep={advance} />}
          {stage.kind === 'enrol_totp' && <EnrolTotp step={stage.step} onStep={advance} />}
          {stage.kind === 'totp' && <VerifyTotp onStep={advance} />}
          {stage.kind === 'recovery' && <RecoveryCodes codes={stage.step.recoveryCodes ?? []} onDone={() => void advance({ ...stage.step, recoveryCodes: null })} />}
        </Card>
        {stage.kind === 'credentials' && <InstallCard />}
      </div>
      </div>
      <Footer />
    </main>
  )
}

function useSubmit(fn: () => Promise<void>) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true); setError(null)
    try { await fn() } catch (err) { setError(errorMessage(err)) } finally { setBusy(false) }
  }
  return { busy, error, setError, submit }
}

function Credentials({ password, onStep }: { password: React.MutableRefObject<string>; onStep: (s: StepResult) => Promise<void> }) {
  const { t } = useT()
  const [email, setEmail] = useState('')
  const [pw, setPw] = useState('')
  const { busy, error, submit } = useSubmit(async () => {
    const step = await api.signIn(email, pw)
    password.current = pw
    setPw('')
    await onStep(step)
  })
  return (
    <form onSubmit={submit} className="space-y-4">
      <Field label={t('login.email')}>{(id) => <Input id={id} type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" inputMode="email" autoCapitalize="none" spellCheck={false} maxLength={254} required />}</Field>
      <Field label={t('login.password')}>{(id) => <PasswordInput id={id} value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" maxLength={256} required />}</Field>
      {error && <Alert tone="bad">{error}</Alert>}
      <Button type="submit" full loading={busy}>{t('login.submit')}</Button>
      <p className="text-center text-[13px] text-muted">{t('login.help')}</p>
    </form>
  )
}

function ChangePassword({ step, current, onStep }: { step: StepResult; current: React.MutableRefObject<string>; onStep: (s: StepResult) => Promise<void> }) {
  const { t } = useT()
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const { busy, error, setError, submit } = useSubmit(async () => {
    if (next !== confirm) { setError(t('login.mismatch')); return }
    const s = await api.changePassword(current.current, next)
    current.current = ''
    await onStep(s)
  })
  return (
    <form onSubmit={submit} className="space-y-4">
      <div><h2 className="text-[17px] font-semibold">{t('login.changeTitle')}</h2><p className="mt-1 text-[14px] text-muted">{t('login.changeHelp')}</p></div>
      <input type="text" autoComplete="username" value={step.user.email} readOnly hidden />
      <Field label={t('login.newPassword')} hint={t('login.passwordRule')}>{(id, d) => <PasswordInput id={id} aria-describedby={d} value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" minLength={10} maxLength={128} required />}</Field>
      <Field label={t('login.confirmPassword')}>{(id) => <PasswordInput id={id} value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" maxLength={128} required />}</Field>
      {error && <Alert tone="bad">{error}</Alert>}
      <Button type="submit" full loading={busy}>{t('action.continue')}</Button>
    </form>
  )
}

function CodeField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { t } = useT()
  return <Field label={t('login.code')}>{(id) => <Input id={id} className="token text-center text-[20px] tracking-[0.4em]" value={value} onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" required />}</Field>
}

function EnrolTotp({ step, onStep }: { step: StepResult; onStep: (s: StepResult) => Promise<void> }) {
  const { t } = useT()
  const [qr, setQr] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const { busy, error, submit } = useSubmit(async () => onStep(await api.submitTotp(code)))
  const uri = step.enrolment?.uri ?? ''
  // Drawn on this device; the secret never goes to a QR web service.
  useEffect(() => { QRCode.toDataURL(uri, { margin: 1, width: 220 }).then(setQr).catch(() => setQr(null)) }, [uri])
  return (
    <form onSubmit={submit} className="space-y-4">
      <div><h2 className="text-[17px] font-semibold">{t('login.enrolTitle')}</h2><p className="mt-1 text-[14px] text-muted">{t('login.enrolHelp')}</p></div>
      {qr && <img src={qr} alt="Authenticator setup code" width={200} height={200} className="mx-auto rounded-md bg-white p-2" />}
      <div><p className="text-[13px] text-muted">{t('login.secretKey')}</p><p className="token select-all break-all rounded-md bg-subtle px-3 py-2 text-[13px]">{step.enrolment?.secret.match(/.{1,4}/g)?.join(' ')}</p></div>
      <CodeField value={code} onChange={setCode} />
      {error && <Alert tone="bad">{error}</Alert>}
      <Button type="submit" full loading={busy} disabled={code.length < 6}>{t('action.confirm')}</Button>
    </form>
  )
}

function VerifyTotp({ onStep }: { onStep: (s: StepResult) => Promise<void> }) {
  const { t } = useT()
  const [code, setCode] = useState('')
  const [recovery, setRecovery] = useState(false)
  const { busy, error, submit } = useSubmit(async () => onStep(await api.submitTotp(code)))
  return (
    <form onSubmit={submit} className="space-y-4">
      <div><h2 className="text-[17px] font-semibold">{t('login.totpTitle')}</h2><p className="mt-1 text-[14px] text-muted">{recovery ? t('login.recoveryEnter') : t('login.totpHelp')}</p></div>
      {recovery
        ? <Field label="Recovery code">{(id) => <Input id={id} className="token" value={code} onChange={(e) => setCode(e.target.value.trim())} placeholder="xxxx-xxxx-xxxx" maxLength={20} autoComplete="off" />}</Field>
        : <CodeField value={code} onChange={setCode} />}
      {error && <Alert tone="bad">{error}</Alert>}
      <Button type="submit" full loading={busy} disabled={code.length < 6}>{t('action.confirm')}</Button>
      <button type="button" className="w-full text-center text-[13.5px] text-accent" onClick={() => { setRecovery((r) => !r); setCode('') }}>
        {recovery ? t('login.useApp') : t('login.useRecovery')}
      </button>
    </form>
  )
}

function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const { t } = useT()
  const [saved, setSaved] = useState(false)
  return (
    <div className="space-y-4">
      <div><h2 className="text-[17px] font-semibold">{t('login.recoveryTitle')}</h2><p className="mt-1 text-[14px] text-muted">{t('login.recoveryHelp')}</p></div>
      <ol className="token grid grid-cols-2 gap-2 rounded-md bg-subtle p-4 text-[14px]">{codes.map((c) => <li key={c} className="select-all">{c}</li>)}</ol>
      <Checkbox label={t('login.recoverySaved')} checked={saved} onChange={setSaved} />
      <Button full disabled={!saved} onClick={onDone}>{t('action.continue')}</Button>
    </div>
  )
}

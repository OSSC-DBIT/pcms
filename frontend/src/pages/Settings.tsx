import { useEffect, useState } from 'react'
import { LogOut } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../App'
import InstallCard from '../components/InstallCard'
import { Alert, Button, Card, Field, PageHeader, PasswordInput, Stack, Tabs, errorMessage } from '../components/ui'
import { api } from '../lib/api'
import { useTheme, type Theme } from '../lib/hooks'
import { LANGS, useT, type Lang, type TKey } from '../lib/i18n'
import { disablePush, enablePush, pushState, sendTestPush, type PushState } from '../lib/push'

const PUSH_TEXT: Partial<Record<PushState, TKey>> = {
  'needs-install': 'settings.notif.install', unsupported: 'settings.notif.unsupported',
  'disabled-on-server': 'settings.notif.serverOff', denied: 'settings.notif.denied', on: 'settings.notif.on',
}

export default function Settings() {
  const { t, lang, setLang } = useT()
  const { theme, setTheme } = useTheme()
  const { user, signOut } = useAuth()
  const nav = useNavigate()
  return (
    <Stack className="mx-auto max-w-2xl">
      <PageHeader title={t('nav.settings')} subtitle={user ? `${user.name} · ${user.email}` : undefined} />
      <InstallCard />
      <Card title={t('settings.appearance')}>
        <Stack>
          <Tabs label={t('settings.appearance')} value={theme} onChange={(v: Theme) => setTheme(v)}
            tabs={[{ value: 'light', label: t('settings.light') }, { value: 'dark', label: t('settings.dark') }, { value: 'system', label: t('settings.system') }]} />
          <div>
            <p className="mb-1.5 text-[14px] font-medium">{t('settings.language')}</p>
            <Tabs label={t('settings.language')} value={lang} onChange={(v: Lang) => setLang(v)} tabs={LANGS.map((l) => ({ value: l.code, label: l.label }))} />
          </div>
        </Stack>
      </Card>
      <Notifications />
      <PasswordCard />
      <Button variant="secondary" full onClick={async () => { await signOut(); nav('/login', { replace: true }) }}><LogOut size={17} /> {t('action.signOut')}</Button>
      <p className="text-center text-[13px] text-muted">{t('settings.signOutNote')}</p>
    </Stack>
  )
}

function Notifications() {
  const { t } = useT()
  const [state, setState] = useState<PushState | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  useEffect(() => { pushState().then(setState).catch(() => setState('unsupported')) }, [])
  async function run(fn: () => Promise<PushState>) {
    setBusy(true); setMsg(null)
    try { setState(await fn()) } catch (e) { setMsg(errorMessage(e)) } finally { setBusy(false) }
  }
  const text = state ? PUSH_TEXT[state] : undefined
  return (
    <Card title={t('settings.notifications')}>
      <p className="text-[14px] text-muted">{text ? t(text) : t('settings.notif.help')}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {state === 'off' && <Button loading={busy} onClick={() => run(enablePush)}>{t('settings.notif.enable')}</Button>}
        {state === 'on' && (
          <>
            <Button variant="secondary" loading={busy} onClick={() => run(disablePush)}>{t('settings.notif.disable')}</Button>
            <Button variant="secondary" onClick={async () => {
              try { const r = await sendTestPush(); setMsg(r.sent ? 'Test sent. It should appear in a few seconds.' : 'The test could not be delivered.') } catch (e) { setMsg(errorMessage(e)) }
            }}>{t('settings.notif.test')}</Button>
          </>
        )}
      </div>
      {msg && <div className="mt-3"><Alert>{msg}</Alert></div>}
    </Card>
  )
}

function PasswordCard() {
  const { t } = useT()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null)
  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setMsg(null)
    try { await api.changePassword(current, next); setCurrent(''); setNext(''); setMsg({ tone: 'ok', text: t('settings.password.saved') }) }
    catch (err) { setMsg({ tone: 'bad', text: errorMessage(err) }) } finally { setBusy(false) }
  }
  return (
    <Card title={t('settings.password')}>
      <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
        <Field label={t('settings.password.current')}>{(id) => <PasswordInput id={id} autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />}</Field>
        <Field label={t('login.newPassword')} hint={t('login.passwordRule')}>{(id, d) => <PasswordInput id={id} aria-describedby={d} autoComplete="new-password" minLength={10} maxLength={128} value={next} onChange={(e) => setNext(e.target.value)} required />}</Field>
        <div className="sm:col-span-2"><Button type="submit" variant="secondary" loading={busy}>{t('settings.password.change')}</Button></div>
        {msg && <div className="sm:col-span-2"><Alert tone={msg.tone}>{msg.text}</Alert></div>}
      </form>
    </Card>
  )
}

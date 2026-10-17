import { useState } from 'react'
import { motion } from 'framer-motion'
import { Button, spring } from '../components/ui'
import { api, HttpError } from '../lib/api'
import { useT } from '../lib/i18n'
import { useAuth } from '../App'
import { useNavigate } from 'react-router-dom'

export default function Login() {
  const { t } = useT()
  const { setUser } = useAuth()
  const nav = useNavigate()
  const [employeeId, setEmployeeId] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const user = await api.signIn(employeeId, password)
      setUser(user)
      nav(user.role === 'faculty' ? '/' : '/toal', { replace: true })
    } catch (err) {
      setError(err instanceof HttpError ? err.message : 'Something went wrong. Try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-lg flex-col justify-center px-8">
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ ...spring, stiffness: 300 }}>
        <p className="token text-[13px] tracking-[0.08em] text-muted">DBIT</p>
        <h1 className="mt-1 text-[34px] font-semibold tracking-[-0.03em]">{t('app.name')}</h1>
        <p className="mt-1 text-[15px] text-muted">{t('app.tagline')}</p>

        <form onSubmit={submit} className="mt-10 space-y-4">
          <div>
            <label htmlFor="emp" className="mb-2 block text-[13px] font-medium text-muted">{t('login.employeeId')}</label>
            <input id="emp" value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} autoComplete="username"
              inputMode="text" required
              className="w-full rounded-md border border-line bg-surface px-4 py-3.5 text-[16px] focus:border-fg/40" />
          </div>
          <div>
            <label htmlFor="pw" className="mb-2 block text-[13px] font-medium text-muted">{t('login.password')}</label>
            <input id="pw" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required
              className="w-full rounded-md border border-line bg-surface px-4 py-3.5 text-[16px] focus:border-fg/40" />
          </div>
          {error && (
            <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} role="alert"
              className="rounded-md border border-fg/25 px-4 py-3 text-[14px] leading-5">
              {error}
            </motion.p>
          )}
          <Button type="submit" loading={busy}>{t('login.submit')}</Button>
        </form>
        <p className="mt-5 text-[13px] leading-5 text-muted">{t('login.help')}</p>
        {!api.mock && <p className="token mt-2 text-[11px] text-muted/70">api: {import.meta.env.VITE_API_BASE_URL}</p>}
      </motion.div>
    </main>
  )
}

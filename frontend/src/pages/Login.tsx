import { useState } from 'react'
import { motion } from 'framer-motion'
import { useNavigate } from 'react-router-dom'
import { Button, spring } from '../components/ui'
import { api, HttpError } from '../lib/api'
import { useT } from '../lib/i18n'
import { useAuth } from '../App'

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
      nav(user.role === 'faculty' ? '/' : '/admin', { replace: true })
    } catch (err) {
      setError(err instanceof HttpError ? err.message : 'Something went wrong. Try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-lg flex-col justify-end px-6 pb-14 pt-16 sm:justify-center sm:pb-20">
      <motion.div initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ ...spring, stiffness: 280 }}>
        <div className="mb-10 flex items-center gap-3.5">
          <span aria-hidden className="flex h-14 w-14 items-center justify-center rounded-[16px] bg-inverse text-[24px] font-bold text-inverse-fg shadow-[0_4px_16px_rgba(0,0,0,0.18)]">
            <span className="token">P</span>
          </span>
          <div>
            <h1 className="text-[26px] font-bold leading-none tracking-[-0.03em]">{t('app.name')}</h1>
            <p className="mt-1.5 text-[14px] text-muted">{t('app.tagline')}</p>
          </div>
        </div>

        <form onSubmit={submit} className="space-y-3.5">
          <div className="overflow-hidden rounded-[14px] bg-surface shadow-[0_1px_2px_rgba(0,0,0,0.05)]">
            <div className="flex items-center gap-3 border-b border-line px-4">
              <label htmlFor="emp" className="w-28 shrink-0 text-[14px] font-semibold text-muted">{t('login.employeeId')}</label>
              <input id="emp" value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} autoComplete="username" required
                className="h-[54px] w-full bg-transparent text-[16px] outline-none placeholder:text-muted/50" placeholder="DB0000" />
            </div>
            <div className="flex items-center gap-3">
              <label htmlFor="pw" className="w-28 shrink-0 px-0 text-[14px] font-semibold text-muted">{t('login.password')}</label>
              <input id="pw" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required
                className="h-[54px] w-full bg-transparent pr-4 text-[16px] outline-none placeholder:text-muted/50" placeholder="••••••••" />
            </div>
          </div>
          {error && (
            <motion.p initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} role="alert"
              className="rounded-[13px] border border-fg/25 bg-surface px-4 py-3 text-[13.5px] font-medium leading-5">
              {error}
            </motion.p>
          )}
          <Button type="submit" loading={busy}>{t('login.submit')}</Button>
        </form>
        <p className="pretty mx-auto mt-6 max-w-[36ch] text-center text-[12.5px] leading-5 text-muted">{t('login.help')}</p>
      </motion.div>
    </main>
  )
}

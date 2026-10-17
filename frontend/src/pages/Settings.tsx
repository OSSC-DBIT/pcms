import { Moon, Sun, Monitor, LogOut } from 'lucide-react'
import { PageTitle, Segmented, Fade } from '../components/ui'
import { useTheme } from '../lib/hooks'
import { LANGS, useT } from '../lib/i18n'
import { api } from '../lib/api'
import { useAuth } from '../App'
import { useNavigate } from 'react-router-dom'

export default function Settings() {
  const { t, lang, setLang } = useT()
  const { theme, setTheme } = useTheme()
  const { user, setUser } = useAuth()
  const nav = useNavigate()

  const isAdmin = user && user.role !== 'faculty'

  return (
    <Fade>
      <PageTitle title={t('nav.settings')} />
      <section className="px-5">
        <p className="mb-2 text-[13px] font-medium text-muted">{t('settings.theme')}</p>
        <Segmented label="theme" value={theme} onChange={setTheme} options={[
          { value: 'light', label: <span className="flex items-center justify-center gap-1.5"><Sun size={14} />{t('settings.theme.light')}</span> },
          { value: 'dark', label: <span className="flex items-center justify-center gap-1.5"><Moon size={14} />{t('settings.theme.dark')}</span> },
          { value: 'system', label: <span className="flex items-center justify-center gap-1.5"><Monitor size={14} />{t('settings.theme.system')}</span> },
        ]} />
      </section>
      <section className="mt-7 px-5">
        <p className="mb-2 text-[13px] font-medium text-muted">{t('settings.language')}</p>
        <Segmented label="lang" value={lang} onChange={setLang} options={LANGS.map((l) => ({ value: l.code, label: l.label }))} />
      </section>
      <section className="mt-9 px-5">
        {user && (
          <div className="hairline-b flex items-center justify-between py-3">
            <div>
              <p className="text-[14.5px] font-medium">{user.name}</p>
              <p className="token text-[12.5px] text-muted">{user.employeeId} · {user.role.replace('_', ' ')}</p>
            </div>
            {isAdmin && (
              <button onClick={() => nav('/toal')} className="token rounded-full border border-line px-3.5 py-1.5 text-[12.5px] font-medium">
                TOAL
              </button>
            )}
          </div>
        )}
        <button
          onClick={async () => { await api.signOut(); setUser(null); nav('/login', { replace: true }) }}
          className="mt-5 flex w-full items-center justify-center gap-2 rounded-md border border-line py-3.5 text-[14.5px] font-medium active:bg-subtle"
        >
          <LogOut size={15} /> Sign out
        </button>
        <p className="mt-6 text-center text-[12px] text-muted/70">Private drafts are cleared on sign out.</p>
      </section>
    </Fade>
  )
}

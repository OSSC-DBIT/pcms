import { LogOut, Moon, Sun, Monitor, Shield } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { Button, Card, Fade, LargeHeader, Row, SectionLabel, Segmented } from '../components/ui'
import { useTheme, type Theme } from '../lib/hooks'
import { LANGS, useT } from '../lib/i18n'
import { api } from '../lib/api'
import { useAuth } from '../App'

export default function Settings() {
  const { t, lang, setLang } = useT()
  const { theme, setTheme } = useTheme()
  const { user, setUser } = useAuth()
  const nav = useNavigate()

  const isAdmin = user && user.role !== 'faculty'

  return (
    <Fade className="mx-auto min-h-dvh max-w-lg pb-32">
      <LargeHeader title={t('nav.settings')} />

      <SectionLabel>{t('settings.theme')}</SectionLabel>
      <div className="px-4">
        <Segmented label="theme" value={theme} onChange={(v: Theme) => setTheme(v)} options={[
          { value: 'light', label: <span className="flex items-center justify-center gap-1.5"><Sun size={14} />{t('settings.theme.light')}</span> },
          { value: 'dark', label: <span className="flex items-center justify-center gap-1.5"><Moon size={14} />{t('settings.theme.dark')}</span> },
          { value: 'system', label: <span className="flex items-center justify-center gap-1.5"><Monitor size={14} />{t('settings.theme.system')}</span> },
        ]} />
      </div>

      <SectionLabel>{t('settings.language')}</SectionLabel>
      <div className="px-4">
        <Segmented label="lang" value={lang} onChange={setLang} options={LANGS.map((l) => ({ value: l.code, label: l.label }))} />
      </div>

      <SectionLabel>{t('settings.account')}</SectionLabel>
      <Card className="inset-hr mx-4">
        {user && (
          <Row title={user.name} detail={<span className="token">{user.employeeId} · {user.role.replace('_', ' ')}</span>} chevron={false} />
        )}
        {isAdmin && (
          <Row title={t('settings.admin')} right={<Shield size={17} className="text-muted" />} onClick={() => nav('/admin')} />
        )}
      </Card>

      <div className="px-4 pt-8">
        <Button variant="secondary" onClick={async () => { await api.signOut(); setUser(null); nav('/login', { replace: true }) }}>
          <LogOut size={15} /> {t('settings.signout')}
        </Button>
        <p className="mt-4 text-center text-[11.5px] text-muted/70">{t('settings.draftNote')}</p>
      </div>
    </Fade>
  )
}

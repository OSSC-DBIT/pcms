import { motion } from 'framer-motion'
import { Home, Inbox, Plus, Clock, Settings } from 'lucide-react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useT, type TKey } from '../lib/i18n'
import { spring } from './ui'

const TABS: { path: string; key: TKey; icon: typeof Home }[] = [
  { path: '/', key: 'nav.home', icon: Home },
  { path: '/track', key: 'nav.track', icon: Inbox },
  { path: '/history', key: 'nav.history', icon: Clock },
  { path: '/settings', key: 'nav.settings', icon: Settings },
]

export default function TabBar() {
  const { t } = useT()
  const nav = useNavigate()
  const loc = useLocation()

  return (
    <nav aria-label="Primary" className="safe-bottom fixed inset-x-0 bottom-0 z-30 mx-auto max-w-lg">
      <div className="relative mx-3 mb-3 flex items-center justify-around rounded-[22px] border border-line bg-surface/90 px-1 py-1 shadow-[0_8px_30px_rgba(0,0,0,0.12)] backdrop-blur-2xl">
        {TABS.slice(0, 2).map(({ path, key, icon: Icon }) => <Tab key={path} label={t(key)} Icon={Icon} active={loc.pathname === path} onClick={() => nav(path)} />)}
        <button onClick={() => nav('/report')} aria-label={t('nav.raise')}
          className="flex h-[46px] w-[58px] items-center justify-center rounded-[15px] bg-inverse text-inverse-fg shadow-[0_4px_14px_rgba(0,0,0,0.25)] transition-transform active:scale-90">
          <Plus size={22} strokeWidth={2.4} />
        </button>
        {TABS.slice(2).map(({ path, key, icon: Icon }) => <Tab key={path} label={t(key)} Icon={Icon} active={loc.pathname === path} onClick={() => nav(path)} />)}
      </div>
    </nav>
  )
}

function Tab({ label, Icon, active, onClick }: { label: string; Icon: typeof Home; active: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} aria-current={active ? 'page' : undefined}
      className={`relative flex w-full flex-col items-center gap-0.5 rounded-2xl py-2 text-[10.5px] font-medium transition-colors ${active ? 'text-fg' : 'text-muted'}`}>
      {active && <motion.span layoutId="tab-active" transition={spring} className="absolute inset-0 rounded-2xl bg-fg/8" />}
      <Icon size={19} strokeWidth={active ? 2.1 : 1.7} className="relative" />
      <span className="relative">{label}</span>
    </button>
  )
}

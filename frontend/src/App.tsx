import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Home as HomeIcon, Plus, Inbox, Settings, History as HistoryIcon } from 'lucide-react'
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { api } from './lib/api'
import { useT } from './lib/i18n'
import { spring } from './components/ui'
import type { User } from './lib/types'
import Login from './pages/Login'
import Home from './pages/faculty/Home'
import Raise from './pages/faculty/Raise'
import Track from './pages/faculty/Track'
import History from './pages/faculty/History'
import SettingsPage from './pages/Settings'
import TicketDetail from './pages/faculty/TicketDetail'
import Receipt from './pages/faculty/Receipt'
import ToalHome from './pages/toal/ToalHome'
import ToalTicket from './pages/toal/ToalTicket'
import Workers from './pages/toal/Workers'
import Approvals from './pages/toal/Approvals'
import ToalAdmin from './pages/toal/ToalAdmin'

const AuthCtx = createContext<{ user: User | null; setUser: (u: User | null) => void }>({ user: null, setUser: () => {} })
export const useAuth = () => useContext(AuthCtx)

function TabBar() {
  const { t } = useT()
  const nav = useNavigate()
  const loc = useLocation()
  const tabs = [
    { path: '/', icon: HomeIcon, label: t('nav.home') },
    { path: '/track', icon: Inbox, label: t('nav.track') },
    { path: '/raise', icon: Plus, label: t('nav.raise'), primary: true },
    { path: '/history', icon: HistoryIcon, label: t('nav.history') },
    { path: '/settings', icon: Settings, label: t('nav.settings') },
  ]
  return (
    <nav className="safe-bottom fixed inset-x-0 bottom-0 z-30 border-t border-line bg-bg/92 backdrop-blur-xl" aria-label="Primary">
      <div className="mx-auto flex max-w-lg items-stretch justify-around px-2 pb-1 pt-1.5">
        {tabs.map(({ path, icon: Icon, label, primary }) => {
          const active = loc.pathname === path || (path === '/' && loc.pathname === '/')
          return (
            <button key={path} onClick={() => nav(path)} aria-current={active ? 'page' : undefined}
              className={`relative flex w-full flex-col items-center gap-1 py-1.5 text-[10.5px] tracking-wide ${active ? 'text-fg' : 'text-muted'}`}>
              {active && !primary && (
                <motion.span layoutId="tab-dot" transition={spring} className="absolute -top-1 h-1 w-1 rounded-full bg-fg" />
              )}
              <span className={`flex h-8 w-8 items-center justify-center rounded-full ${primary ? 'bg-inverse text-inverse-fg' : ''}`}>
                <Icon size={primary ? 19 : 19} strokeWidth={active || primary ? 2 : 1.6} />
              </span>
              {label}
            </button>
          )
        })}
      </div>
    </nav>
  )
}

function FacultyLayout({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto min-h-dvh max-w-lg pb-24">
      {children}
      <TabBar />
    </div>
  )
}

function Protected({ children, admin }: { children: ReactNode; admin?: boolean }) {
  const { user } = useAuth()
  if (!user) return <Navigate to="/login" replace />
  if (admin && !user.capabilities.some((c) => c.startsWith('queue') || c.startsWith('admin') || c === 'cost.approve' || c === 'worker.directory' || c === 'ticket.triage'))
    return <Navigate to="/" replace />
  return <>{children}</>
}

export default function App() {
  const { user, setUser } = useAuth2()
  const loc = useLocation()
  return (
    <AuthCtx.Provider value={{ user, setUser }}>
      <AnimatePresence initial={false} mode="popLayout">
        <motion.div key={loc.pathname} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, position: 'absolute', inset: 0, pointerEvents: 'none' }} transition={{ duration: 0.16, ease: 'easeOut' }} className="min-h-dvh">
          <Routes location={loc}>
            <Route path="/login" element={<Login />} />
            <Route path="/" element={<Protected><FacultyLayout><Home /></FacultyLayout></Protected>} />
            <Route path="/raise/*" element={<Protected><Raise /></Protected>} />
            <Route path="/track" element={<Protected><FacultyLayout><Track /></FacultyLayout></Protected>} />
            <Route path="/history" element={<Protected><FacultyLayout><History /></FacultyLayout></Protected>} />
            <Route path="/settings" element={<Protected><FacultyLayout><SettingsPage /></FacultyLayout></Protected>} />
            <Route path="/t/:id" element={<Protected><TicketDetail /></Protected>} />
            <Route path="/receipt/:id" element={<Protected><Receipt /></Protected>} />
            <Route path="/toal" element={<Protected admin><ToalHome /></Protected>} />
            <Route path="/toal/t/:id" element={<Protected admin><ToalTicket /></Protected>} />
            <Route path="/toal/workers" element={<Protected admin><Workers /></Protected>} />
            <Route path="/toal/approvals" element={<Protected admin><Approvals /></Protected>} />
            <Route path="/toal/admin" element={<Protected admin><ToalAdmin /></Protected>} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </motion.div>
      </AnimatePresence>
    </AuthCtx.Provider>
  )
}

function useAuth2() {
  const [user, setUser] = useState<User | null>(() => api.restore())
  useEffect(() => {
    const fn = () => { if (!sessionStorage.getItem('pcms.session')) setUser(null) }
    addEventListener('storage', fn)
    return () => removeEventListener('storage', fn)
  }, [])
  return { user, setUser }
}

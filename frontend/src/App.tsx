import { createContext, useContext, useRef, useState, type ReactNode } from 'react'
import { motion } from 'framer-motion'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { api } from './lib/api'
import TabBar from './components/TabBar'
import Login from './pages/Login'
import Home from './pages/faculty/Home'
import Report from './pages/faculty/Report'
import Track from './pages/faculty/Track'
import History from './pages/faculty/History'
import SettingsPage from './pages/Settings'
import TicketDetail from './pages/faculty/TicketDetail'
import Receipt from './pages/faculty/Receipt'
import AdminHome from './pages/admin/AdminHome'
import AdminTicket from './pages/admin/AdminTicket'
import Workers from './pages/admin/Workers'
import Approvals from './pages/admin/Approvals'
import AdminSettings from './pages/admin/AdminSettings'
import type { User } from './lib/types'

const AuthCtx = createContext<{ user: User | null; setUser: (u: User | null) => void }>({ user: null, setUser: () => {} })
export const useAuth = () => useContext(AuthCtx)

const ADMIN_CAPS = ['queue.view', 'cost.approve', 'worker.directory', 'ticket.triage', 'admin.catalogs']

function Protected({ children, admin }: { children: ReactNode; admin?: boolean }) {
  const { user } = useAuth()
  if (!user) return <Navigate to="/login" replace />
  if (admin && !user.capabilities.some((c) => ADMIN_CAPS.includes(c))) return <Navigate to="/" replace />
  return <>{children}</>
}

function useDirection(pathname: string) {
  const stack = useRef<string[]>([pathname])
  const dir = useRef<1 | -1>(1)
  const prev = useRef(pathname)
  if (pathname !== prev.current) {
    const s = stack.current
    if (s.length >= 2 && s[s.length - 2] === pathname) { s.pop(); dir.current = -1 }
    else { s.push(pathname); dir.current = 1 }
    prev.current = pathname
  }
  return dir.current
}

export default function App() {
  const [user, setUser] = useState<User | null>(() => api.restore())
  const loc = useLocation()
  const dir = useDirection(loc.pathname)

  return (
    <AuthCtx.Provider value={{ user, setUser }}>
      <div className="app-frame">
        <motion.div
          key={loc.pathname}
          initial={{ opacity: 0, x: dir === 1 ? 18 : -18 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ type: 'spring', stiffness: 460, damping: 38, mass: 0.8 }}
        >
          <Routes location={loc}>
            <Route path="/login" element={<Login />} />
            <Route path="/" element={<Protected><Home /></Protected>} />
            <Route path="/report/*" element={<Protected><Report /></Protected>} />
            <Route path="/track" element={<Protected><Track /></Protected>} />
            <Route path="/history" element={<Protected><History /></Protected>} />
            <Route path="/settings" element={<Protected><SettingsPage /></Protected>} />
            <Route path="/t/:id" element={<Protected><TicketDetail /></Protected>} />
            <Route path="/receipt/:id" element={<Protected><Receipt /></Protected>} />
            <Route path="/admin" element={<Protected admin><AdminHome /></Protected>} />
            <Route path="/admin/t/:id" element={<Protected admin><AdminTicket /></Protected>} />
            <Route path="/admin/workers" element={<Protected admin><Workers /></Protected>} />
            <Route path="/admin/approvals" element={<Protected admin><Approvals /></Protected>} />
            <Route path="/admin/settings" element={<Protected admin><AdminSettings /></Protected>} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </motion.div>
        {(loc.pathname === '/' || loc.pathname === '/track' || loc.pathname === '/history' || loc.pathname === '/settings') && <TabBar />}
      </div>
    </AuthCtx.Provider>
  )
}

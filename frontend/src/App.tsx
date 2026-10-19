import { createContext, lazy, Suspense, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import AppShell from './components/AppShell'
import ReloadPrompt from './components/ReloadPrompt'
import { Button, Spinner } from './components/ui'
import { api, clearLocalData } from './lib/api'
import { loadCatalogs } from './lib/catalog'
import type { Capability, User } from './lib/types'
import Landing from './pages/Landing'
import Login from './pages/Login'
import Settings from './pages/Settings'
import Home from './pages/faculty/Home'
import Receipt from './pages/faculty/Receipt'
import Report from './pages/faculty/Report'
import Tickets from './pages/faculty/Tickets'
import TicketView from './pages/faculty/TicketView'

// Staff screens load only for people who open them.
const Queue = lazy(() => import('./pages/staff/Queue'))
const StaffTicket = lazy(() => import('./pages/staff/StaffTicket'))
const Approvals = lazy(() => import('./pages/staff/Approvals'))
const Workers = lazy(() => import('./pages/staff/Workers'))
const Admin = lazy(() => import('./pages/staff/Admin'))
const Reports = lazy(() => import('./pages/staff/Reports'))
const Audit = lazy(() => import('./pages/staff/Audit'))

interface AuthState {
  user: User | null
  signedIn: (u: User) => Promise<void>
  signOut: () => Promise<void>
  can: (cap: Capability) => boolean
}

const AuthCtx = createContext<AuthState | null>(null)

export function useAuth(): AuthState {
  const ctx = useContext(AuthCtx)
  if (!ctx) throw new Error('useAuth outside AuthProvider')
  return ctx
}

export function homeFor(u: User): string {
  if (u.role === 'faculty') return '/home'
  return u.capabilities.includes('queue.view') ? '/staff' : '/staff/admin'
}

function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [user, setUser] = useState<User | null>(null)

  const signedIn = useCallback(async (u: User) => { await loadCatalogs(true); setUser(u) }, [])

  const boot = useCallback(async () => {
    setStatus('loading')
    try {
      const u = await api.me()
      if (u) await signedIn(u)
      else setUser(null)
      setStatus('ready')
    } catch { setStatus('error') }
  }, [signedIn])

  useEffect(() => { void boot() }, [boot])
  useEffect(() => {
    // Any 401 from the API (expired, revoked, suspended) ends the local session.
    const ended = () => { clearLocalData(); setUser(null) }
    window.addEventListener('pcms:session-ended', ended)
    return () => window.removeEventListener('pcms:session-ended', ended)
  }, [])

  const signOut = useCallback(async () => { await api.signOut(); setUser(null) }, [])
  const can = useCallback((cap: Capability) => !!user?.capabilities.includes(cap), [user])

  if (status === 'loading') return <div className="flex min-h-dvh items-center justify-center"><Spinner /></div>
  if (status === 'error') {
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="text-[17px] font-semibold">PCMS is not reachable</p>
        <p className="text-[14px] text-muted">Check that you are on the campus network, then try again.</p>
        <Button onClick={() => void boot()}>Try again</Button>
      </main>
    )
  }
  return <AuthCtx.Provider value={{ user, signedIn, signOut, can }}>{children}</AuthCtx.Provider>
}

/** UI gate only; the server checks every permission on every request. */
function Gate({ children, cap, anyCap, faculty }: { children: ReactNode; cap?: Capability; anyCap?: Capability[]; faculty?: boolean }) {
  const { user, can } = useAuth()
  if (!user) return <Navigate to="/login" replace />
  if (faculty && user.role !== 'faculty') return <Navigate to={homeFor(user)} replace />
  if ((cap && !can(cap)) || (anyCap && !anyCap.some(can))) return <Navigate to={homeFor(user)} replace />
  return <AppShell><Suspense fallback={<Spinner />}>{children}</Suspense></AppShell>
}

function AppRoutes() {
  const { user } = useAuth()
  return (
    <Routes>
      <Route path="/login" element={user ? <Navigate to={homeFor(user)} replace /> : <Login />} />
      <Route path="/" element={user ? <Navigate to={homeFor(user)} replace /> : <Landing />} />
      <Route path="/home" element={<Gate faculty><Home /></Gate>} />
      <Route path="/report" element={<Gate cap="ticket.create"><Report /></Gate>} />
      <Route path="/tickets" element={<Gate><Tickets /></Gate>} />
      <Route path="/t/:id" element={<Gate><TicketView /></Gate>} />
      <Route path="/receipt/:id" element={<Gate><Receipt /></Gate>} />
      <Route path="/settings" element={<Gate><Settings /></Gate>} />
      <Route path="/staff" element={<Gate cap="queue.view"><Queue /></Gate>} />
      <Route path="/staff/t/:id" element={<Gate cap="queue.view"><StaffTicket /></Gate>} />
      <Route path="/staff/approvals" element={<Gate cap="cost.approve"><Approvals /></Gate>} />
      <Route path="/staff/workers" element={<Gate cap="worker.directory"><Workers /></Gate>} />
      <Route path="/staff/reports" element={<Gate cap="queue.view"><Reports /></Gate>} />
      <Route path="/staff/audit" element={<Gate cap="admin.audit"><Audit /></Gate>} />
      <Route path="/staff/admin" element={<Gate anyCap={['admin.users', 'admin.catalogs', 'admin.locations', 'admin.audit']}><Admin /></Gate>} />
      {/* Links in older notifications */}
      <Route path="/toal/t/:id" element={<LegacyTicket />} />
      <Route path="/toal/*" element={<Navigate to="/staff" replace />} />
      <Route path="*" element={<Navigate to={user ? homeFor(user) : '/'} replace />} />
    </Routes>
  )
}

function LegacyTicket() {
  const id = location.pathname.split('/').pop()
  return <Navigate to={`/staff/t/${id}`} replace />
}

export default function App() {
  return (
    <AuthProvider>
      <AppRoutes />
      <ReloadPrompt />
    </AuthProvider>
  )
}

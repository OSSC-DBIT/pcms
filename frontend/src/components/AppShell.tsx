import { clsx } from 'clsx'
import type { ReactNode } from 'react'
import { BarChart3, ClipboardList, Home, LayoutDashboard, PlusCircle, ScrollText, Settings, ShieldCheck, Wallet, type LucideIcon } from 'lucide-react'
import { NavLink } from 'react-router-dom'
import { useAuth } from '../App'
import NotificationPrompt from './NotificationPrompt'
import { Footer, InstituteMark } from './Brand'
import { useT, type TKey } from '../lib/i18n'
import { useOnline } from '../lib/hooks'
import type { Capability } from '../lib/types'

interface Item { to: string; label: TKey; icon: LucideIcon; cap?: Capability; anyCap?: Capability[]; end?: boolean; mobile?: boolean }

const FACULTY: Item[] = [
  { to: '/home', label: 'nav.home', icon: Home, end: true },
  { to: '/report', label: 'nav.report', icon: PlusCircle, cap: 'ticket.create' },
  { to: '/tickets', label: 'nav.tickets', icon: ClipboardList },
  { to: '/settings', label: 'nav.settings', icon: Settings },
]

const STAFF: Item[] = [
  { to: '/staff', label: 'nav.queue', icon: LayoutDashboard, cap: 'queue.view', end: true },
  { to: '/staff/approvals', label: 'nav.approvals', icon: Wallet, cap: 'cost.approve' },
  { to: '/report', label: 'nav.report', icon: PlusCircle, cap: 'ticket.create' },
  // Secondary screens: reachable from the sidebar, but the phone tab bar has no room.
  { to: '/staff/reports', label: 'nav.reports', icon: BarChart3, cap: 'queue.view', mobile: false },
  { to: '/staff/audit', label: 'nav.audit', icon: ScrollText, cap: 'admin.audit', mobile: false },
  { to: '/staff/admin', label: 'nav.admin', icon: ShieldCheck, anyCap: ['admin.users', 'admin.catalogs', 'admin.locations', 'admin.audit'] },
  { to: '/settings', label: 'nav.settings', icon: Settings },
]

export default function AppShell({ children }: { children: ReactNode }) {
  const { user, can } = useAuth()
  const { t } = useT()
  const online = useOnline()
  const base = user?.role === 'faculty' ? FACULTY : STAFF
  const items = base.filter((i) => (!i.cap || can(i.cap)) && (!i.anyCap || i.anyCap.some(can)))

  return (
    <div className="min-h-dvh md:flex">
      {user && <NotificationPrompt />}
      {/* Desktop sidebar */}
      <aside className="hidden w-60 shrink-0 border-r border-line bg-surface md:flex md:flex-col">
        <div className="px-5 py-5"><InstituteMark /></div>
        <nav aria-label="Main" className="flex-1 space-y-1 px-3">
          {items.map((i) => <SideLink key={i.to} item={i} label={t(i.label)} />)}
        </nav>
        {user && (
          <div className="border-t border-line px-5 py-4 text-[13px]">
            <p className="truncate font-medium">{user.name}</p>
            <p className="token text-muted">{user.email} · {user.role.replace('_', ' ')}</p>
          </div>
        )}
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Phone top bar */}
        <header className="safe-top sticky top-0 z-20 border-b border-line bg-surface/95 backdrop-blur md:hidden">
          <div className="flex h-12 items-center gap-2 px-4">
            <img src="/pwa-64x64.png" alt="" width={24} height={24} className="rounded" />
            <span className="text-[15px] font-semibold">PCMS</span>
            <span className="text-[12.5px] text-muted">· DBIT Bengaluru</span>
            {user && <span className="ml-auto truncate text-[12.5px] text-muted">{user.name}</span>}
          </div>
        </header>
        {!online && <div role="status" className="bg-warn-soft px-4 py-2 text-center text-[13px]">{t('error.offline')}</div>}
        <main className="mx-auto w-full max-w-5xl flex-1 px-4 pt-5 md:px-8 md:pt-8">{children}</main>
        <Footer className="mt-8 pb-24 md:pb-5" />
      </div>

      {/* Phone bottom tabs */}
      <nav aria-label="Main" className="safe-bottom fixed inset-x-0 bottom-0 z-20 border-t border-line bg-surface/95 backdrop-blur md:hidden">
        <div className="mx-auto flex max-w-lg justify-around">
          {items.filter((i) => i.mobile !== false).map((i) => (
            <NavLink key={i.to} to={i.to} end={i.end}
              className={({ isActive }) => clsx('flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 text-[11px]', isActive ? 'text-accent' : 'text-muted')}>
              <i.icon size={21} aria-hidden />
              {t(i.label)}
            </NavLink>
          ))}
        </div>
      </nav>
    </div>
  )
}

function SideLink({ item, label }: { item: Item; label: string }) {
  return (
    <NavLink to={item.to} end={item.end}
      className={({ isActive }) => clsx('flex h-10 items-center gap-3 rounded-md px-3 text-[14.5px]',
        isActive ? 'bg-accent-soft font-medium text-accent' : 'text-fg hover:bg-subtle')}>
      <item.icon size={18} aria-hidden />
      {label}
    </NavLink>
  )
}

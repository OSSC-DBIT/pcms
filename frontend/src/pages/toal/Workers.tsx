import { useEffect, useState } from 'react'
import { api, category } from '../../lib/api'
import { useAuth } from '../../App'
import { useT } from '../../lib/i18n'
import { Button, Fade, NavBar, Segmented, Skeleton } from '../../components/ui'
import type { Worker } from '../../lib/types'

export default function Workers() {
  const { t } = useT()
  const { user } = useAuth()
  const [workers, setWorkers] = useState<Worker[] | null>(null)
  const [filter, setFilter] = useState<'active' | 'all'>('active')
  const canManage = user?.capabilities.includes('worker.manage')

  useEffect(() => { let l = true; api.listWorkers().then((w) => l && setWorkers(w)); return () => { l = false } }, [])

  const shown = (workers ?? []).filter((w) => filter === 'all' || w.active)

  return (
    <Fade className="mx-auto min-h-dvh max-w-lg">
      <NavBar title={t('nav.settings') === 'सेटिंग्स' ? 'श्रमिक' : 'Workers'} />
      <div className="px-5 pb-3 pt-4">
        <Segmented label="wfilter" value={filter} onChange={setFilter} options={[
          { value: 'active', label: 'Active' }, { value: 'all', label: 'All' },
        ]} />
        <p className="mt-3 text-[12px] leading-4 text-muted">Phone numbers are restricted. Contacts verified monthly and after any failed delivery. Workers have no login — jobs go over WhatsApp, SMS, or call.</p>
      </div>
      {workers === null ? (
        <div className="space-y-4 px-5">{[...Array(4)].map((_, i) => <Skeleton key={i} className="h-16" />)}</div>
      ) : shown.map((w) => (
        <div key={w.id} className="hairline-b flex items-center justify-between gap-3 px-5 py-4">
          <div className="min-w-0">
            <p className="truncate text-[14.5px] font-medium">{w.name}</p>
            <p className="token mt-0.5 text-[12px] text-muted">{w.phoneMasked} · {w.mode} · {w.kind === 'vendor' ? 'vendor' : 'employee'}</p>
            <p className="mt-0.5 truncate text-[12px] text-muted">{w.trades.map((tr) => category(tr).nameEn).join(', ')} · {w.area} · {w.language.toUpperCase()}</p>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-2">
            <span className={`rounded-full px-2.5 py-0.5 text-[12px] font-medium ${w.active ? 'bg-inverse text-inverse-fg' : 'border border-line text-muted'}`}>
              {w.workload} jobs
            </span>
            {canManage && (
              <Button variant="ghost" className="h-7 w-auto px-1 text-[12px]" onClick={async () => {
                const nw = await api.setWorkerActive(w.id, !w.active)
                setWorkers((ws) => ws!.map((x) => x.id === nw.id ? nw : x))
              }}>{w.active ? 'Deactivate' : 'Activate'}</Button>
            )}
          </div>
        </div>
      ))}
      <p className="px-5 py-6 text-[12px] text-muted">Last verified {shown[0]?.lastVerified ?? '—'}. Inactive workers cannot receive new jobs; history is preserved.</p>
    </Fade>
  )
}

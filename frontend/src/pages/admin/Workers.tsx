import { useEffect, useState } from 'react'
import { UserRoundSearch } from 'lucide-react'
import { api, category, localName } from '../../lib/api'
import { useAuth } from '../../App'
import { useT } from '../../lib/i18n'
import { Button, Card, EmptyState, Fade, NavBar, SectionLabel, Segmented, Skeleton } from '../../components/ui'
import type { Worker } from '../../lib/types'

export default function Workers() {
  const { lang } = useT()
  const { user } = useAuth()
  const [workers, setWorkers] = useState<Worker[] | null>(null)
  const [filter, setFilter] = useState<'active' | 'all'>('active')
  const canManage = user?.capabilities.includes('worker.manage')

  useEffect(() => { let l = true; api.listWorkers().then((w) => l && setWorkers(w)); return () => { l = false } }, [])

  const shown = (workers ?? []).filter((w) => filter === 'all' || w.active)

  return (
    <Fade className="mx-auto min-h-dvh max-w-lg pb-12">
      <NavBar title="Worker directory" />
      <div className="px-4 pb-1 pt-5">
        <Segmented label="wfilter" value={filter} onChange={setFilter} options={[{ value: 'active', label: 'Active' }, { value: 'all', label: 'All' }]} />
        <p className="pretty mt-3 text-[12px] leading-4 text-muted">Phone numbers are restricted. Contacts verified monthly and after any failed delivery. Workers have no login — jobs go over WhatsApp, SMS, or call.</p>
      </div>
      {workers === null ? (
        <div className="space-y-2.5 px-4 pt-4">{[...Array(3)].map((_, i) => <Skeleton key={i} className="h-[68px]" />)}</div>
      ) : shown.length === 0 ? (
        <EmptyState icon={<UserRoundSearch size={26} />} title="No workers yet" body="Facilities maintains this list. Add worker names, trades and verified numbers before dispatch." />
      ) : (
        <>
          <SectionLabel>{shown.length} on record</SectionLabel>
          <Card className="inset-hr mx-4">
            {shown.map((w) => (
              <div key={w.id} className="flex min-h-[62px] items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="truncate text-[14.5px] font-medium">{w.name}</p>
                  <p className="token mt-0.5 truncate text-[12px] text-muted">{w.phoneMasked} · {w.mode} · {w.kind === 'vendor' ? 'vendor' : 'employee'}</p>
                  <p className="mt-0.5 truncate text-[12px] text-muted">{w.trades.map((tr) => localName(category(tr), lang)).join(', ')} · {w.area}</p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-2">
                  <span className={`rounded-full px-2.5 py-0.5 text-[11.5px] font-semibold ${w.active ? 'bg-inverse text-inverse-fg' : 'border border-line text-muted'}`}>
                    {w.active ? `${w.workload} jobs` : 'inactive'}
                  </span>
                  {canManage && <Button variant="ghost" className="h-7 w-auto px-1 text-[12px]" onClick={async () => {
                    const nw = await api.setWorkerActive(w.id, !w.active)
                    setWorkers((ws) => ws!.map((x) => x.id === nw.id ? nw : x))
                  }}>{w.active ? 'Deactivate' : 'Activate'}</Button>}
                </div>
              </div>
            ))}
          </Card>
        </>
      )}
    </Fade>
  )
}

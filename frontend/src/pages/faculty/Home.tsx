import { Link } from 'react-router-dom'
import { Plus } from 'lucide-react'
import { useAuth } from '../../App'
import InstallCard from '../../components/InstallCard'
import { TicketList, TicketRow } from '../../components/ticket'
import { Alert, Button, EmptyState, PageHeader, Skeleton, Stack } from '../../components/ui'
import { useT } from '../../lib/i18n'
import { useTickets } from '../../lib/useTickets'
import { TERMINAL } from '../../lib/types'

export default function Home() {
  const { t } = useT()
  const { user } = useAuth()
  const { tickets, error } = useTickets('mine')
  const open = tickets?.filter((x) => !TERMINAL.includes(x.status)) ?? []
  const check = open.filter((x) => x.status === 'Resolved')
  const others = open.filter((x) => x.status !== 'Resolved')

  return (
    <Stack className="space-y-6">
      <PageHeader title={`Hello, ${user?.name.split(' ')[0] ?? ''}`} subtitle={t('home.subtitle')}
        actions={<Link to="/report"><Button><Plus size={18} /> {t('home.report')}</Button></Link>} />
      <InstallCard dismissible />
      {error && <Alert tone="bad">{error}</Alert>}
      {tickets === null ? <Skeleton className="h-40" /> : (
        <>
          {check.length > 0 && (
            <section>
              <h2 className="mb-2 text-[16px] font-semibold">{t('home.awaiting')}</h2>
              <TicketList>{check.map((x) => <TicketRow key={x.id} ticket={x} to={`/t/${x.id}`} />)}</TicketList>
            </section>
          )}
          <section>
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-[16px] font-semibold">{t('home.open')} ({others.length})</h2>
              <Link to="/tickets" className="text-[14px] text-accent">{t('home.seeAll')}</Link>
            </div>
            {others.length === 0
              ? <EmptyState title={t('home.empty')} action={<Link to="/report"><Button variant="secondary"><Plus size={16} /> {t('home.report')}</Button></Link>} />
              : <TicketList>{others.slice(0, 6).map((x) => <TicketRow key={x.id} ticket={x} to={`/t/${x.id}`} />)}</TicketList>}
          </section>
        </>
      )}
    </Stack>
  )
}

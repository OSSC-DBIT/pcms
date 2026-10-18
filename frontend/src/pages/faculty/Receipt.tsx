import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { CheckCircle2, Printer } from 'lucide-react'
import { placeText, typeText } from '../../components/ticket'
import { Button, Card, Spinner } from '../../components/ui'
import { api } from '../../lib/api'
import { useT } from '../../lib/i18n'
import type { Ticket } from '../../lib/types'

export default function Receipt() {
  const { id } = useParams()
  const { t, lang } = useT()
  const [ticket, setTicket] = useState<Ticket | null | undefined>(undefined)
  useEffect(() => { if (id) api.getTicket(id).then(setTicket).catch(() => setTicket(null)) }, [id])

  if (ticket === undefined) return <Spinner />
  if (ticket === null) return <p className="text-muted">{t('ticket.notFound')}</p>
  return (
    <div className="mx-auto max-w-md">
      <Card className="text-center">
        <CheckCircle2 size={44} className="mx-auto text-ok" aria-hidden />
        <h1 className="mt-3 text-[20px] font-semibold">{t('receipt.title')}</h1>
        <p className="mt-4 text-[13px] font-medium uppercase tracking-wide text-muted">Token</p>
        <p className="token mt-1 text-[38px] font-bold" data-testid="receipt-token">{ticket.token}</p>
        <p className="mt-2 text-[14.5px]">{ticket.title}</p>
        <p className="mt-1 text-[13.5px] text-muted">{typeText(ticket, lang)} · {placeText(ticket, lang)}</p>
        <p className="mt-4 text-[14px] text-muted">{t('receipt.body')}</p>
        <div className="mt-6 flex flex-col gap-2">
          <Link to={`/t/${ticket.id}`}><Button full>{t('receipt.view')}</Button></Link>
          <Button variant="secondary" full onClick={() => window.print()}><Printer size={16} /> {t('receipt.print')}</Button>
          <Link to="/home" className="mt-1 text-[14px] text-accent">{t('receipt.home')}</Link>
        </div>
      </Card>
    </div>
  )
}

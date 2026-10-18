import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, BadgeCheck } from 'lucide-react'
import { useAuth } from '../../App'
import { Gallery, Messages, TicketSummaryCard, Timeline, fmtTime } from '../../components/ticket'
import { Alert, Button, Card, Spinner, Stack, Textarea, errorMessage } from '../../components/ui'
import { api, HttpError } from '../../lib/api'
import { useT } from '../../lib/i18n'
import { TERMINAL, type Ticket } from '../../lib/types'

export default function TicketView() {
  const { id } = useParams()
  const { user } = useAuth()
  const { t } = useT()
  const [ticket, setTicket] = useState<Ticket | null | undefined>(undefined)
  const [disputing, setDisputing] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => { if (id) setTicket(await api.getTicket(id)) }, [id])
  useEffect(() => { load().catch(() => setTicket(null)) }, [load])

  if (ticket === undefined) return <Spinner />
  if (ticket === null) return <p className="text-muted">{t('ticket.notFound')}</p>
  const mine = ticket.reporterId === user?.id

  async function act(fn: () => Promise<Ticket>) {
    setBusy(true); setError(null)
    try { setTicket(await fn()); setDisputing(false); setReason('') }
    catch (e) {
      setError(errorMessage(e))
      if (e instanceof HttpError && e.code === 'stale_version') await load()
    } finally { setBusy(false) }
  }

  return (
    <Stack className="mx-auto max-w-4xl">
      <Link to="/tickets" className="inline-flex items-center gap-1 text-[14px] text-accent"><ArrowLeft size={16} /> {t('nav.tickets')}</Link>
      <TicketSummaryCard ticket={ticket}>
        {ticket.nextUpdateDue && !TERMINAL.includes(ticket.status) && ticket.status !== 'Resolved' && (
          <p className="mt-2 text-[13px] text-muted">{t('ticket.nextUpdate')} {fmtTime(ticket.nextUpdateDue)}</p>
        )}
      </TicketSummaryCard>

      {error && <Alert tone="bad">{error}</Alert>}

      {mine && ticket.status === 'Resolved' && (
        <Alert tone="ok" title={t('ticket.fixedTitle')}>
          <p>{t('ticket.fixedBody')}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button loading={busy && !disputing} onClick={() => act(() => api.transition(ticket, { action: 'verify' }))}>{t('ticket.verify')}</Button>
            <Button variant="secondary" onClick={() => setDisputing((v) => !v)}>{t('ticket.notFixed')}</Button>
          </div>
          {disputing && (
            <div className="mt-3 space-y-2">
              <Textarea rows={3} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} aria-label={t('ticket.whatWrong')} placeholder={t('ticket.whatWrong')} />
              <Button loading={busy} disabled={!reason.trim()} onClick={() => act(() => api.transition(ticket, { action: 'dispute', reason: reason.trim() }))}>{t('ticket.send')}</Button>
            </div>
          )}
        </Alert>
      )}
      {ticket.verifiedByReporter && <Alert tone="ok"><span className="inline-flex items-center gap-2"><BadgeCheck size={16} /> {t('ticket.verified')}</span></Alert>}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={t('ticket.timeline')}><Timeline events={ticket.events} /></Card>
        <Stack>
          <Card title={t('ticket.evidence')}>
            <Gallery ticket={ticket} canAdd={mine && !TERMINAL.includes(ticket.status)} onChanged={load} />
          </Card>
          <Card title={t('ticket.messages')}>
            <Messages comments={ticket.comments} onSend={async (body) => { setTicket(await api.addComment(ticket, body, false)) }} />
          </Card>
        </Stack>
      </div>
    </Stack>
  )
}

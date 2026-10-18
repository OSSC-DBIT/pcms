import { useCallback, useEffect, useState } from 'react'
import { api, HttpError } from './api'
import type { Status, TicketSummary } from './types'

/** Loads a ticket list; exposes an error message instead of failing silently. */
export function useTickets(scope: 'mine' | 'queue', opts: { status?: Status[]; open?: boolean } = {}) {
  const [tickets, setTickets] = useState<TicketSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const key = `${scope}|${opts.status?.join(',') ?? ''}|${opts.open ?? ''}`

  const load = useCallback(async (signal?: AbortSignal) => {
    setError(null)
    try {
      const page = await api.listTickets({ scope, status: opts.status, open: opts.open })
      if (!signal?.aborted) setTickets(page.items)
    } catch (err) {
      if (signal?.aborted) return
      setError(err instanceof HttpError ? err.message : 'Could not load tickets.')
      setTickets((t) => t ?? [])
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  useEffect(() => {
    const ctl = new AbortController()
    void load(ctl.signal)
    return () => ctl.abort()
  }, [load])

  return { tickets, error, reload: () => load() }
}

import { useCallback, useEffect, useRef, useState } from 'react'
import { api, HttpError, type TicketFilters } from './api'
import type { TicketSummary } from './types'

export interface UseTicketsOptions extends Omit<TicketFilters, 'scope'> {
  pageSize?: number
}

/**
 * Loads one page of tickets. Exposes an error message instead of failing silently,
 * and keeps the server's `total` so callers can show real page counts instead of
 * silently truncating at the page size.
 *
 * Changing any filter resets to page 1, so narrowing a list never lands the reader
 * on an empty tail page.
 */
export function useTickets(scope: 'mine' | 'queue', opts: UseTicketsOptions = {}) {
  const [tickets, setTickets] = useState<TicketSummary[] | null>(null)
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(opts.pageSize ?? 25)
  const [error, setError] = useState<string | null>(null)

  // One key for every filter, so a change refetches exactly once.
  const key = JSON.stringify([scope, opts])
  const lastKey = useRef(key)
  const lastSize = useRef(pageSize)

  const load = useCallback(async (atPage: number, size: number, signal?: AbortSignal) => {
    setError(null)
    try {
      const p = await api.listTickets({ ...opts, scope, page: atPage, pageSize: size })
      if (signal?.aborted) return
      setTickets(p.items)
      setTotal(p.total)
    } catch (err) {
      if (signal?.aborted) return
      setError(err instanceof HttpError ? err.message : 'Could not load tickets.')
      setTickets((t) => t ?? [])
      setTotal(0)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  useEffect(() => {
    // New filters, or a different page size, both restart from the first page.
    const restart = lastKey.current !== key || lastSize.current !== pageSize
    lastKey.current = key
    lastSize.current = pageSize
    if (restart && page !== 1) setPage(1)
    const ctl = new AbortController()
    void load(restart ? 1 : page, pageSize, ctl.signal)
    return () => ctl.abort()
  }, [load, page, pageSize])

  return {
    tickets,
    error,
    total,
    page,
    pageSize,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
    setPage,
    setPageSize,
    reload: () => load(page, pageSize),
  }
}

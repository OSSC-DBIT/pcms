/** Page controls for a server-paged list. Shows the real total so nothing looks silently truncated. */
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useT } from '../lib/i18n'
import { Button } from './ui'

export function Pager({ page, pageCount, total, pageSize, onPage, onPageSize }: {
  page: number
  pageCount: number
  total: number
  pageSize: number
  onPage: (p: number) => void
  onPageSize?: (n: number) => void
}) {
  const { t } = useT()
  if (total === 0) return null
  const first = (page - 1) * pageSize + 1
  const last = Math.min(total, page * pageSize)
  return (
    <nav aria-label={t('common.page', { page, pages: pageCount })} className="flex flex-wrap items-center justify-between gap-3 text-[13.5px]">
      <p className="text-muted">
        {t('common.showing', { first, last, total })}
        {pageCount > 1 && <span className="ml-2">{t('common.page', { page, pages: pageCount })}</span>}
      </p>
      <div className="flex items-center gap-2">
        {onPageSize && (
          <label className="flex items-center gap-1.5 text-muted">
            <span>{t('common.perPage')}</span>
            <select aria-label={t('common.rowsPerPage')} value={pageSize} onChange={(e) => onPageSize(Number(e.target.value))}
              className="h-9 rounded-md border border-line bg-surface px-2 text-[13.5px] text-fg">
              {[10, 25, 50, 100].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
        )}
        <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label={t('action.previous')}>
          <ChevronLeft size={16} /> {t('action.previous')}
        </Button>
        <Button size="sm" variant="secondary" disabled={page >= pageCount} onClick={() => onPage(page + 1)} aria-label={t('action.next')}>
          {t('action.next')} <ChevronRight size={16} />
        </Button>
      </div>
    </nav>
  )
}

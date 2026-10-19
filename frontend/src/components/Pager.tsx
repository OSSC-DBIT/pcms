/** Page controls for a server-paged list. Shows the real total so nothing looks silently truncated. */
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Button } from './ui'

export function Pager({ page, pageCount, total, pageSize, onPage, onPageSize }: {
  page: number
  pageCount: number
  total: number
  pageSize: number
  onPage: (p: number) => void
  onPageSize?: (n: number) => void
}) {
  if (total === 0) return null
  const first = (page - 1) * pageSize + 1
  const last = Math.min(total, page * pageSize)
  return (
    <nav aria-label="Pagination" className="flex flex-wrap items-center justify-between gap-3 text-[13.5px]">
      <p className="text-muted">
        Showing <span className="font-medium text-fg">{first}-{last}</span> of <span className="font-medium text-fg">{total}</span>
        {pageCount > 1 && <span className="ml-2">Page {page} of {pageCount}</span>}
      </p>
      <div className="flex items-center gap-2">
        {onPageSize && (
          <label className="flex items-center gap-1.5 text-muted">
            <span>Per page</span>
            <select aria-label="Rows per page" value={pageSize} onChange={(e) => onPageSize(Number(e.target.value))}
              className="h-9 rounded-md border border-line bg-surface px-2 text-[13.5px] text-fg">
              {[10, 25, 50, 100].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
        )}
        <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Previous page">
          <ChevronLeft size={16} /> Prev
        </Button>
        <Button size="sm" variant="secondary" disabled={page >= pageCount} onClick={() => onPage(page + 1)} aria-label="Next page">
          Next <ChevronRight size={16} />
        </Button>
      </div>
    </nav>
  )
}

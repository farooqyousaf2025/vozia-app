import { IconChevronLeft, IconChevronRight } from './Icons';

interface PaginationProps {
  page: number;
  limit: number;
  total: number;
  onChange: (page: number) => void;
}

/** Windowed page buttons plus an "x–y of z" summary. */
export function Pagination({ page, limit, total, onChange }: PaginationProps) {
  const pageCount = Math.max(1, Math.ceil(total / Math.max(1, limit)));
  const first = total === 0 ? 0 : (page - 1) * limit + 1;
  const last = Math.min(page * limit, total);

  // Show at most 7 numbered buttons centred on the current page.
  const windowSize = 7;
  let start = Math.max(1, page - Math.floor(windowSize / 2));
  const end = Math.min(pageCount, start + windowSize - 1);
  start = Math.max(1, end - windowSize + 1);
  const pages: number[] = [];
  for (let p = start; p <= end; p += 1) pages.push(p);

  const arrowClass =
    'focus-ring grid h-8 w-8 place-items-center rounded-lg border border-edge bg-elevated text-muted transition hover:border-violet-500/50 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40';

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-1 pt-3">
      <p className="text-xs text-faint">
        Showing <span className="text-muted">{first.toLocaleString('en-US')}</span>
        {'–'}
        <span className="text-muted">{last.toLocaleString('en-US')}</span> of{' '}
        <span className="text-muted">{total.toLocaleString('en-US')}</span>
      </p>
      <div className="flex items-center gap-1.5">
        <button type="button" className={arrowClass} onClick={() => onChange(page - 1)} disabled={page <= 1} aria-label="Previous page">
          <IconChevronLeft className="h-4 w-4" />
        </button>
        {pages.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => onChange(p)}
            aria-current={p === page ? 'page' : undefined}
            className={`focus-ring h-8 min-w-8 rounded-lg border px-2 text-xs font-medium transition ${
              p === page
                ? 'border-transparent bg-gradient-to-r from-violet-600 to-fuchsia-600 text-white'
                : 'border-edge bg-elevated text-muted hover:border-violet-500/50 hover:text-ink'
            }`}
          >
            {p}
          </button>
        ))}
        <button type="button" className={arrowClass} onClick={() => onChange(page + 1)} disabled={page >= pageCount} aria-label="Next page">
          <IconChevronRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

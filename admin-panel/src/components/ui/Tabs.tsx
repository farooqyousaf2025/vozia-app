// ---------------------------------------------------------------------------
// Section tabs for the multi-view back-office pages (rules / matches / disputes).
// ---------------------------------------------------------------------------
import { IconChevronRight } from './Icons';

export interface TabItem {
  id: string;
  label: string;
  /** A count shown as a chip; a non-zero `alert` count is coloured amber. */
  count?: number;
  alert?: boolean;
}

interface TabsProps {
  items: TabItem[];
  active: string;
  onChange: (id: string) => void;
}

export function Tabs({ items, active, onChange }: TabsProps) {
  return (
    <div role="tablist" className="flex flex-wrap items-center gap-1 rounded-xl border border-edge/60 bg-surface/60 p-1">
      {items.map((item) => {
        const isActive = item.id === active;
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(item.id)}
            className={`focus-ring inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium transition ${
              isActive ? 'bg-brand-gradient-soft text-violet-200' : 'text-muted hover:bg-elevated/70 hover:text-ink'
            }`}
          >
            {isActive && <IconChevronRight className="h-3.5 w-3.5" />}
            {item.label}
            {item.count !== undefined && (
              <span
                className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold tabular-nums ${
                  item.alert ? 'bg-amber-500/20 text-amber-200' : 'bg-elevated text-faint'
                }`}
              >
                {item.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

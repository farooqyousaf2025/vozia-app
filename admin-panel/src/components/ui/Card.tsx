import type { ReactNode } from 'react';

interface CardProps {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  className?: string;
  bodyClassName?: string;
  children?: ReactNode;
}

export function Card({ title, subtitle, actions, className = '', bodyClassName = '', children }: CardProps) {
  return (
    <section className={`panel ${className}`}>
      {(title !== undefined || actions !== undefined) && (
        <header className="panel-header">
          <div className="min-w-0">
            {title !== undefined && <h2 className="truncate text-sm font-semibold text-ink">{title}</h2>}
            {subtitle !== undefined && <p className="mt-0.5 text-xs text-muted">{subtitle}</p>}
          </div>
          {actions !== undefined && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={bodyClassName.length > 0 ? bodyClassName : 'p-5'}>{children}</div>
    </section>
  );
}

export type StatTone = 'violet' | 'fuchsia' | 'emerald' | 'amber' | 'sky' | 'rose';

const toneStyles: Record<StatTone, { icon: string; value: string }> = {
  violet: { icon: 'bg-violet-500/15 text-violet-300', value: 'text-violet-200' },
  fuchsia: { icon: 'bg-fuchsia-500/15 text-fuchsia-300', value: 'text-fuchsia-200' },
  emerald: { icon: 'bg-emerald-500/15 text-emerald-300', value: 'text-emerald-300' },
  amber: { icon: 'bg-amber-500/15 text-amber-300', value: 'text-amber-300' },
  sky: { icon: 'bg-sky-500/15 text-sky-300', value: 'text-sky-300' },
  rose: { icon: 'bg-rose-500/15 text-rose-300', value: 'text-rose-300' },
};

interface StatCardProps {
  label: string;
  /** A count or a pre-formatted amount; numbers are rendered as-is. */
  value: string | number;
  sub?: ReactNode;
  icon?: ReactNode;
  tone?: StatTone;
}

export function StatCard({ label, value, sub, icon, tone = 'violet' }: StatCardProps) {
  const styles = toneStyles[tone];
  return (
    <div className="panel p-4 transition hover:border-violet-500/40">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wider text-faint">{label}</p>
          <p className={`mt-1.5 text-2xl font-bold tabular-nums ${styles.value}`}>{value}</p>
          {sub !== undefined && <p className="mt-1 truncate text-xs text-muted">{sub}</p>}
        </div>
        {icon !== undefined && (
          <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${styles.icon}`}>
            {icon}
          </span>
        )}
      </div>
    </div>
  );
}

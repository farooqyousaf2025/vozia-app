import type { ReactNode } from 'react';

export type BadgeTone = 'violet' | 'fuchsia' | 'green' | 'red' | 'amber' | 'sky' | 'slate' | 'pink';

const toneClasses: Record<BadgeTone, string> = {
  violet: 'bg-violet-500/15 text-violet-200 border-violet-500/40',
  fuchsia: 'bg-fuchsia-500/15 text-fuchsia-200 border-fuchsia-500/40',
  pink: 'bg-pink-500/15 text-pink-200 border-pink-500/40',
  green: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40',
  red: 'bg-rose-500/15 text-rose-300 border-rose-500/40',
  amber: 'bg-amber-500/15 text-amber-300 border-amber-500/40',
  sky: 'bg-sky-500/15 text-sky-300 border-sky-500/40',
  slate: 'bg-slate-500/15 text-slate-300 border-slate-500/40',
};

interface BadgeProps {
  tone?: BadgeTone;
  className?: string;
  children: ReactNode;
}

export function Badge({ tone = 'violet', className = '', children }: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${toneClasses[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

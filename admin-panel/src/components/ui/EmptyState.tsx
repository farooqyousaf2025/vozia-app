import type { ReactNode } from 'react';

interface EmptyStateProps {
  title: string;
  message?: string;
  icon?: ReactNode;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ title, message, icon, action, className = '' }: EmptyStateProps) {
  return (
    <div className={`flex flex-col items-center justify-center gap-2 px-6 py-12 text-center ${className}`}>
      {icon !== undefined && (
        <span className="grid h-12 w-12 place-items-center rounded-2xl bg-brand-gradient-soft text-violet-300">
          {icon}
        </span>
      )}
      <p className="text-sm font-semibold text-ink">{title}</p>
      {message !== undefined && <p className="max-w-sm text-xs text-muted">{message}</p>}
      {action !== undefined && <div className="mt-2">{action}</div>}
    </div>
  );
}

import { useId, type ReactNode, type SelectHTMLAttributes } from 'react';
import { IconChevronDown } from './Icons';

interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'className' | 'children'> {
  label?: string;
  error?: string | null;
  className?: string;
  /** options as children (<option> elements) for full native flexibility */
  children: ReactNode;
}

export function Select({ label, error, className = '', id, children, ...rest }: SelectProps) {
  const autoId = useId();
  const selectId = id ?? autoId;
  const invalid = error !== undefined && error !== null && error.length > 0;

  return (
    <div className={`min-w-0 ${className}`}>
      {label !== undefined && (
        <label htmlFor={selectId} className="mb-1.5 block text-xs font-medium text-muted">
          {label}
        </label>
      )}
      <div className="relative">
        <select
          id={selectId}
          aria-invalid={invalid}
          className={`focus-ring h-9 w-full cursor-pointer appearance-none rounded-lg border bg-elevated pl-3 pr-9 text-sm text-ink disabled:cursor-not-allowed disabled:opacity-50 ${
            invalid ? 'border-rose-500/70' : 'border-edge hover:border-violet-500/40'
          }`}
          {...rest}
        >
          {children}
        </select>
        <IconChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" />
      </div>
      {invalid && <p className="mt-1 text-xs text-rose-400">{error}</p>}
    </div>
  );
}

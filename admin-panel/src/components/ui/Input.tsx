import { useId, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from 'react';

interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'className'> {
  label?: string;
  error?: string | null;
  hint?: string;
  leadingIcon?: ReactNode;
  className?: string;
}

export function Input({ label, error, hint, leadingIcon, className = '', id, ...rest }: InputProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const invalid = error !== undefined && error !== null && error.length > 0;

  return (
    <div className={`min-w-0 ${className}`}>
      {label !== undefined && (
        <label htmlFor={inputId} className="mb-1.5 block text-xs font-medium text-muted">
          {label}
        </label>
      )}
      <div className="relative">
        {leadingIcon !== undefined && (
          <span className="pointer-events-none absolute inset-y-0 left-0 grid w-9 place-items-center text-faint">
            {leadingIcon}
          </span>
        )}
        <input
          id={inputId}
          aria-invalid={invalid}
          className={`focus-ring h-9 w-full rounded-lg border bg-elevated px-3 text-sm text-ink placeholder:text-faint disabled:cursor-not-allowed disabled:opacity-50 ${
            leadingIcon !== undefined ? 'pl-9' : ''
          } ${invalid ? 'border-rose-500/70' : 'border-edge hover:border-violet-500/40'}`}
          {...rest}
        />
      </div>
      {invalid && <p className="mt-1 text-xs text-rose-400">{error}</p>}
      {!invalid && hint !== undefined && <p className="mt-1 text-xs text-faint">{hint}</p>}
    </div>
  );
}

interface TextareaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'className'> {
  label?: string;
  error?: string | null;
  className?: string;
}

export function Textarea({ label, error, className = '', id, ...rest }: TextareaProps) {
  const autoId = useId();
  const textareaId = id ?? autoId;
  const invalid = error !== undefined && error !== null && error.length > 0;

  return (
    <div className={`min-w-0 ${className}`}>
      {label !== undefined && (
        <label htmlFor={textareaId} className="mb-1.5 block text-xs font-medium text-muted">
          {label}
        </label>
      )}
      <textarea
        id={textareaId}
        aria-invalid={invalid}
        className={`focus-ring w-full rounded-lg border bg-elevated px-3 py-2 text-sm text-ink placeholder:text-faint disabled:cursor-not-allowed disabled:opacity-50 ${
          invalid ? 'border-rose-500/70' : 'border-edge hover:border-violet-500/40'
        }`}
        {...rest}
      />
      {invalid && <p className="mt-1 text-xs text-rose-400">{error}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Self-contained toast system: ToastProvider + useToast(). No external kit.
// ---------------------------------------------------------------------------
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { IconAlert, IconCheck, IconClose } from './Icons';

type ToastVariant = 'success' | 'error' | 'info';

interface ToastItem {
  id: number;
  message: string;
  variant: ToastVariant;
}

interface ToastApi {
  success: (message: string) => void;
  error: (message: string) => void;
  info: (message: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const variantClasses: Record<ToastVariant, string> = {
  success: 'border-emerald-500/50 bg-emerald-950/90 text-emerald-100',
  error: 'border-rose-500/50 bg-rose-950/90 text-rose-100',
  info: 'border-violet-500/50 bg-surface/95 text-violet-100',
};

function ToastIcon({ variant }: { variant: ToastVariant }) {
  if (variant === 'success') {
    return (
      <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-emerald-500/25 text-emerald-300">
        <IconCheck className="h-3.5 w-3.5" />
      </span>
    );
  }
  return (
    <span
      className={`grid h-6 w-6 shrink-0 place-items-center rounded-full ${
        variant === 'error' ? 'bg-rose-500/25 text-rose-300' : 'bg-violet-500/25 text-violet-300'
      }`}
    >
      <IconAlert className="h-3.5 w-3.5" />
    </span>
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback(
    (message: string, variant: ToastVariant) => {
      const id = nextId.current;
      nextId.current += 1;
      setToasts((current) => [...current.slice(-4), { id, message, variant }]);
      window.setTimeout(() => dismiss(id), 4500);
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(
    () => ({
      success: (message: string) => push(message, 'success'),
      error: (message: string) => push(message, 'error'),
      info: (message: string) => push(message, 'info'),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed right-4 top-4 z-[90] flex w-[calc(100vw-2rem)] max-w-sm flex-col gap-2"
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`pointer-events-auto flex animate-toast-in items-center gap-3 rounded-xl border px-4 py-3 text-sm shadow-lg backdrop-blur ${variantClasses[toast.variant]}`}
            role="status"
          >
            <ToastIcon variant={toast.variant} />
            <p className="min-w-0 flex-1 break-words">{toast.message}</p>
            <button
              type="button"
              onClick={() => dismiss(toast.id)}
              aria-label="Dismiss notification"
              className="shrink-0 text-current opacity-60 transition hover:opacity-100"
            >
              <IconClose className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used inside <ToastProvider>');
  }
  return context;
}
